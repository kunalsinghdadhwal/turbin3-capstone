import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MultisigVault } from "../target/types/multisig_vault";
import {
    PublicKey,
    Keypair,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    createMint,
    createAssociatedTokenAccount,
    mintTo,
    getAssociatedTokenAddressSync,
    getAccount,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("multisig-vault", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.multisigVault as Program<MultisigVault>;
    const connection = provider.connection;
    const wallet = provider.wallet as anchor.Wallet;

    // ----- Keypairs -----
    const signer1 = wallet.payer; // also the vault creator
    const signer2 = Keypair.generate();
    const signer3 = Keypair.generate();
    const nonSigner = Keypair.generate();
    const recipient = Keypair.generate();

    // ----- PDA helpers -----
    function getVaultPda(creator: PublicKey): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), creator.toBuffer()],
            program.programId,
        );
    }

    function getProposalPda(
        vault: PublicKey,
        proposalId: number,
    ): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [
                Buffer.from("proposal"),
                vault.toBuffer(),
                new BN(proposalId).toArrayLike(Buffer, "le", 8),
            ],
            program.programId,
        );
    }

    // ----- Utility helpers -----
    async function airdrop(to: PublicKey, sol: number) {
        const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
    }

    async function expectError(fn: () => Promise<any>, errorCode: string) {
        try {
            await fn();
            expect.fail(`Expected transaction to fail with ${errorCode}`);
        } catch (err: any) {
            if (err.message?.includes("Expected transaction to fail"))
                throw err;
            const msg = err.logs?.join("\n") ?? err.message ?? err.toString();
            expect(msg).to.include(
                errorCode,
                `Expected error ${errorCode} but got: ${msg.slice(0, 300)}`,
            );
        }
    }

    async function fetchProposalCount(): Promise<number> {
        const v = await program.account.vaultConfig.fetch(vaultPda);
        return v.proposalCount.toNumber();
    }

    // ----- Shared state across ordered test blocks -----
    const signersList = [
        signer1.publicKey,
        signer2.publicKey,
        signer3.publicKey,
    ];
    const threshold = 2; // 2-of-3
    const [vaultPda] = getVaultPda(signer1.publicKey);

    // SPL token state (populated in deposit_token before block)
    let testMint: PublicKey;
    const TOKEN_DECIMALS = 6;
    const MINT_AMOUNT = 1_000_000 * 10 ** TOKEN_DECIMALS;

    // Proposal PDAs populated during tests
    let solProposalPda: PublicKey; // proposal 0: SOL withdrawal
    let splProposalPda: PublicKey; // proposal 1: SPL withdrawal
    let pricedProposalPda: PublicKey; // proposal 2: with price condition

    // Pyth SOL/USD feed ID (same on devnet and mainnet)
    const SOL_USD_FEED_ID: number[] = Array.from(
        Buffer.from(
            "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
            "hex",
        ),
    );

    // ----- Global setup -----
    before(async () => {
        await Promise.all([
            airdrop(signer2.publicKey, 5),
            airdrop(signer3.publicKey, 5),
            airdrop(nonSigner.publicKey, 5),
            airdrop(recipient.publicKey, 1),
        ]);
    });

    // =========================================================
    //  PHASE 1 -- CORE MULTI-SIG VAULT
    // =========================================================

    // ------- initialize -------
    describe("initialize", () => {
        it("creates a 2-of-3 vault", async () => {
            await program.methods
                .initialize(signersList, threshold)
                .accounts({
                    creator: signer1.publicKey,
                    vaultConfig: vaultPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const vault = await program.account.vaultConfig.fetch(vaultPda);
            expect(vault.creator.equals(signer1.publicKey)).to.be.true;
            expect(vault.signers).to.have.lengthOf(3);
            expect(vault.signers[0].equals(signer1.publicKey)).to.be.true;
            expect(vault.signers[1].equals(signer2.publicKey)).to.be.true;
            expect(vault.signers[2].equals(signer3.publicKey)).to.be.true;
            expect(vault.threshold).to.equal(2);
            expect(vault.proposalCount.toNumber()).to.equal(0);
        });

        it("creates a 1-of-1 vault (edge case)", async () => {
            const solo = Keypair.generate();
            await airdrop(solo.publicKey, 2);
            const [pda] = getVaultPda(solo.publicKey);

            await program.methods
                .initialize([solo.publicKey], 1)
                .accounts({
                    creator: solo.publicKey,
                    vaultConfig: pda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([solo])
                .rpc();

            const vault = await program.account.vaultConfig.fetch(pda);
            expect(vault.threshold).to.equal(1);
            expect(vault.signers).to.have.lengthOf(1);
        });

        it("fails with threshold = 0", async () => {
            const c = Keypair.generate();
            await airdrop(c.publicKey, 2);
            const [pda] = getVaultPda(c.publicKey);

            await expectError(
                () =>
                    program.methods
                        .initialize([c.publicKey, signer2.publicKey], 0)
                        .accounts({
                            creator: c.publicKey,
                            vaultConfig: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([c])
                        .rpc(),
                "InvalidThreshold",
            );
        });

        it("fails with threshold > number of signers", async () => {
            const c = Keypair.generate();
            await airdrop(c.publicKey, 2);
            const [pda] = getVaultPda(c.publicKey);

            await expectError(
                () =>
                    program.methods
                        .initialize([c.publicKey, signer2.publicKey], 5)
                        .accounts({
                            creator: c.publicKey,
                            vaultConfig: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([c])
                        .rpc(),
                "InvalidThreshold",
            );
        });

        it("fails with empty signers list", async () => {
            const c = Keypair.generate();
            await airdrop(c.publicKey, 2);
            const [pda] = getVaultPda(c.publicKey);

            await expectError(
                () =>
                    program.methods
                        .initialize([], 1)
                        .accounts({
                            creator: c.publicKey,
                            vaultConfig: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([c])
                        .rpc(),
                "InvalidThreshold",
            );
        });

        it("fails with more than 10 signers", async () => {
            const c = Keypair.generate();
            await airdrop(c.publicKey, 2);
            const [pda] = getVaultPda(c.publicKey);
            const tooMany = Array.from(
                { length: 11 },
                () => Keypair.generate().publicKey,
            );

            await expectError(
                () =>
                    program.methods
                        .initialize(tooMany, 5)
                        .accounts({
                            creator: c.publicKey,
                            vaultConfig: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([c])
                        .rpc(),
                "TooManySigners",
            );
        });

        it("fails with duplicate signers", async () => {
            const c = Keypair.generate();
            await airdrop(c.publicKey, 2);
            const [pda] = getVaultPda(c.publicKey);

            await expectError(
                () =>
                    program.methods
                        .initialize(
                            [
                                signer2.publicKey,
                                signer2.publicKey,
                                signer3.publicKey,
                            ],
                            2,
                        )
                        .accounts({
                            creator: c.publicKey,
                            vaultConfig: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([c])
                        .rpc(),
                "DuplicateSigner",
            );
        });
    });

    // ------- deposit_sol -------
    describe("deposit_sol", () => {
        const depositAmount = 2 * LAMPORTS_PER_SOL;

        it("deposits SOL into the vault PDA", async () => {
            const before = await connection.getBalance(vaultPda, "confirmed");

            await program.methods
                .depositSol(new BN(depositAmount))
                .accounts({
                    depositor: signer1.publicKey,
                    vaultConfig: vaultPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const after = await connection.getBalance(vaultPda, "confirmed");
            expect(after - before).to.equal(depositAmount);
        });

        it("allows a non-signer to deposit", async () => {
            const before = await connection.getBalance(vaultPda, "confirmed");

            await program.methods
                .depositSol(new BN(LAMPORTS_PER_SOL))
                .accounts({
                    depositor: nonSigner.publicKey,
                    vaultConfig: vaultPda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([nonSigner])
                .rpc();

            const after = await connection.getBalance(vaultPda, "confirmed");
            expect(after - before).to.equal(LAMPORTS_PER_SOL);
        });

        it("accumulates balance across multiple deposits", async () => {
            const before = await connection.getBalance(vaultPda, "confirmed");

            await program.methods
                .depositSol(new BN(LAMPORTS_PER_SOL))
                .accounts({
                    depositor: signer2.publicKey,
                    vaultConfig: vaultPda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([signer2])
                .rpc();

            const after = await connection.getBalance(vaultPda, "confirmed");
            expect(after - before).to.equal(LAMPORTS_PER_SOL);
        });
    });

    // ------- deposit_token -------
    describe("deposit_token", () => {
        before(async () => {
            // Create an SPL mint owned by signer1
            testMint = await createMint(
                connection,
                wallet.payer,
                signer1.publicKey, // mint authority
                null,
                TOKEN_DECIMALS,
            );

            // Create signer1's ATA and mint tokens
            const ata = await createAssociatedTokenAccount(
                connection,
                wallet.payer,
                testMint,
                signer1.publicKey,
            );
            await mintTo(
                connection,
                wallet.payer,
                testMint,
                ata,
                signer1, // mint authority
                MINT_AMOUNT,
            );
        });

        it("deposits SPL tokens into vault ATA (creates it via init_if_needed)", async () => {
            const depositorAta = getAssociatedTokenAddressSync(
                testMint,
                signer1.publicKey,
            );
            const vaultAta = getAssociatedTokenAddressSync(
                testMint,
                vaultPda,
                true, // allowOwnerOffCurve for PDA
            );
            const depositAmt = 500_000 * 10 ** TOKEN_DECIMALS;

            await program.methods
                .depositToken(new BN(depositAmt))
                .accounts({
                    depositor: signer1.publicKey,
                    vaultConfig: vaultPda,
                    mint: testMint,
                    depositorAta: depositorAta,
                    vaultAta: vaultAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const vaultTokenAcct = await getAccount(connection, vaultAta);
            expect(Number(vaultTokenAcct.amount)).to.equal(depositAmt);
        });

        it("deposits additional tokens (balance accumulates)", async () => {
            const vaultAta = getAssociatedTokenAddressSync(
                testMint,
                vaultPda,
                true,
            );
            const depositorAta = getAssociatedTokenAddressSync(
                testMint,
                signer1.publicKey,
            );
            const secondDeposit = 100_000 * 10 ** TOKEN_DECIMALS;

            const before = await getAccount(connection, vaultAta);

            await program.methods
                .depositToken(new BN(secondDeposit))
                .accounts({
                    depositor: signer1.publicKey,
                    vaultConfig: vaultPda,
                    mint: testMint,
                    depositorAta: depositorAta,
                    vaultAta: vaultAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const after = await getAccount(connection, vaultAta);
            expect(Number(after.amount) - Number(before.amount)).to.equal(
                secondDeposit,
            );
        });
    });

    // ------- create_proposal -------
    describe("create_proposal", () => {
        const withdrawAmount = LAMPORTS_PER_SOL; // 1 SOL

        it("creates a SOL withdrawal proposal (proposal 0)", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);
            solProposalPda = pda;

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(withdrawAmount),
                    { sol: {} },
                    "Pay contributor for work",
                    null, // no price condition
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: solProposalPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const prop = await program.account.proposal.fetch(solProposalPda);
            expect(prop.vault.equals(vaultPda)).to.be.true;
            expect(prop.proposalId.toNumber()).to.equal(proposalId);
            expect(prop.proposer.equals(signer1.publicKey)).to.be.true;
            expect(prop.recipient.equals(recipient.publicKey)).to.be.true;
            expect(prop.amount.toNumber()).to.equal(withdrawAmount);
            expect(prop.description).to.equal("Pay contributor for work");
            expect(prop.status).to.deep.equal({ active: {} });
        });

        it("auto-approves for the proposer", async () => {
            const prop = await program.account.proposal.fetch(solProposalPda);
            expect(prop.approvals).to.have.lengthOf(1);
            expect(prop.approvals[0].equals(signer1.publicKey)).to.be.true;
        });

        it("increments proposal_count on the vault", async () => {
            const count = await fetchProposalCount();
            // proposal 0 was created above, so count should be >= 1
            expect(count).to.be.greaterThanOrEqual(1);
        });

        it("creates an SPL token withdrawal proposal (proposal 1)", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);
            splProposalPda = pda;

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(100_000 * 10 ** TOKEN_DECIMALS),
                    { splToken: { mint: testMint } },
                    "Token grant",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: splProposalPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const prop = await program.account.proposal.fetch(splProposalPda);
            expect(prop.status).to.deep.equal({ active: {} });
            expect(prop.transferType).to.deep.equal({
                splToken: { mint: testMint },
            });
        });

        it("creates a proposal with a price condition (proposal 2)", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);
            pricedProposalPda = pda;

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL / 2),
                    { sol: {} },
                    "Conditional SOL transfer",
                    {
                        feedId: SOL_USD_FEED_ID,
                        minPrice: new BN(15_000_000_000), // $150 at exponent -8
                        maxPrice: null,
                        maxAgeSecs: new BN(30),
                    },
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pricedProposalPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const prop =
                await program.account.proposal.fetch(pricedProposalPda);
            expect(prop.priceCondition).to.not.be.null;
            expect(prop.priceCondition.feedId).to.deep.equal(SOL_USD_FEED_ID);
            expect(prop.priceCondition.minPrice.toNumber()).to.equal(
                15_000_000_000,
            );
            expect(prop.priceCondition.maxPrice).to.be.null;
            expect(prop.priceCondition.maxAgeSecs.toNumber()).to.equal(30);
        });

        it("fails when a non-signer proposes", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);

            await expectError(
                () =>
                    program.methods
                        .createProposal(
                            recipient.publicKey,
                            new BN(LAMPORTS_PER_SOL),
                            { sol: {} },
                            "Unauthorized",
                            null,
                        )
                        .accounts({
                            proposer: nonSigner.publicKey,
                            vaultConfig: vaultPda,
                            proposal: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([nonSigner])
                        .rpc(),
                "UnauthorizedSigner",
            );
        });

        it("fails when description exceeds 200 characters", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);
            const longDesc = "x".repeat(201);

            await expectError(
                () =>
                    program.methods
                        .createProposal(
                            recipient.publicKey,
                            new BN(LAMPORTS_PER_SOL),
                            { sol: {} },
                            longDesc,
                            null,
                        )
                        .accounts({
                            proposer: signer1.publicKey,
                            vaultConfig: vaultPda,
                            proposal: pda,
                            systemProgram: SystemProgram.programId,
                        })
                        .rpc(),
                "DescriptionTooLong",
            );
        });
    });

    // ------- approve_proposal -------
    describe("approve_proposal", () => {
        // Uses solProposalPda (proposal 0) which has 1 approval (signer1).
        // Threshold is 2-of-3.

        it("second signer approves, reaching threshold -> status Approved", async () => {
            await program.methods
                .approveProposal()
                .accounts({
                    signer: signer2.publicKey,
                    vaultConfig: vaultPda,
                    proposal: solProposalPda,
                })
                .signers([signer2])
                .rpc();

            const prop = await program.account.proposal.fetch(solProposalPda);
            expect(prop.approvals).to.have.lengthOf(2);
            expect(prop.approvals[1].equals(signer2.publicKey)).to.be.true;
            expect(prop.status).to.deep.equal({ approved: {} });
        });

        it("fails when signer has already voted (approved)", async () => {
            // signer2 already approved above
            await expectError(
                () =>
                    program.methods
                        .approveProposal()
                        .accounts({
                            signer: signer2.publicKey,
                            vaultConfig: vaultPda,
                            proposal: solProposalPda,
                        })
                        .signers([signer2])
                        .rpc(),
                "AlreadyVoted",
            );
        });

        it("fails when non-signer tries to approve", async () => {
            // Use splProposalPda (proposal 1) which is still Active
            await expectError(
                () =>
                    program.methods
                        .approveProposal()
                        .accounts({
                            signer: nonSigner.publicKey,
                            vaultConfig: vaultPda,
                            proposal: splProposalPda,
                        })
                        .signers([nonSigner])
                        .rpc(),
                "UnauthorizedSigner",
            );
        });

        it("fails when proposal is not Active", async () => {
            // solProposalPda is now Approved, not Active
            await expectError(
                () =>
                    program.methods
                        .approveProposal()
                        .accounts({
                            signer: signer3.publicKey,
                            vaultConfig: vaultPda,
                            proposal: solProposalPda,
                        })
                        .signers([signer3])
                        .rpc(),
                "ProposalNotActive",
            );
        });

        it("approves SPL proposal to threshold (for later execute test)", async () => {
            // splProposalPda has 1 approval (signer1). Add signer2 -> Approved.
            await program.methods
                .approveProposal()
                .accounts({
                    signer: signer2.publicKey,
                    vaultConfig: vaultPda,
                    proposal: splProposalPda,
                })
                .signers([signer2])
                .rpc();

            const prop = await program.account.proposal.fetch(splProposalPda);
            expect(prop.status).to.deep.equal({ approved: {} });
        });
    });

    // ------- reject_proposal -------
    describe("reject_proposal", () => {
        // Create a fresh proposal (proposal N) for rejection tests
        let rejectProposalPda: PublicKey;

        before(async () => {
            const proposalId = await fetchProposalCount();
            [rejectProposalPda] = getProposalPda(vaultPda, proposalId);

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL),
                    { sol: {} },
                    "Proposal to be rejected",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: rejectProposalPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        });

        it("signer rejects a proposal", async () => {
            await program.methods
                .rejectProposal()
                .accounts({
                    signer: signer2.publicKey,
                    vaultConfig: vaultPda,
                    proposal: rejectProposalPda,
                })
                .signers([signer2])
                .rpc();

            const prop =
                await program.account.proposal.fetch(rejectProposalPda);
            expect(prop.rejections).to.have.lengthOf(1);
            expect(prop.rejections[0].equals(signer2.publicKey)).to.be.true;
            // Still Active: 1 approval (signer1) + 1 unvoted (signer3) can reach 2
            expect(prop.status).to.deep.equal({ active: {} });
        });

        it("fails when signer already voted (approved earlier)", async () => {
            // signer1 auto-approved at creation, cannot reject
            await expectError(
                () =>
                    program.methods
                        .rejectProposal()
                        .accounts({
                            signer: signer1.publicKey,
                            vaultConfig: vaultPda,
                            proposal: rejectProposalPda,
                        })
                        .rpc(),
                "AlreadyVoted",
            );
        });

        it("fails when non-signer rejects", async () => {
            await expectError(
                () =>
                    program.methods
                        .rejectProposal()
                        .accounts({
                            signer: nonSigner.publicKey,
                            vaultConfig: vaultPda,
                            proposal: rejectProposalPda,
                        })
                        .signers([nonSigner])
                        .rpc(),
                "UnauthorizedSigner",
            );
        });

        it("auto-rejects when threshold can no longer be met", async () => {
            // signer3 rejects: approvals=1, rejections=2, unvoted=0 -> impossible
            await program.methods
                .rejectProposal()
                .accounts({
                    signer: signer3.publicKey,
                    vaultConfig: vaultPda,
                    proposal: rejectProposalPda,
                })
                .signers([signer3])
                .rpc();

            const prop =
                await program.account.proposal.fetch(rejectProposalPda);
            expect(prop.rejections).to.have.lengthOf(2);
            expect(prop.status).to.deep.equal({ rejected: {} });
        });
    });

    // ------- execute_sol_proposal -------
    describe("execute_sol_proposal", () => {
        // solProposalPda (proposal 0) is Approved and requests 1 SOL to recipient

        it("executes an approved proposal, SOL transferred to recipient", async () => {
            const vaultBefore = await connection.getBalance(
                vaultPda,
                "confirmed",
            );
            const recipientBefore = await connection.getBalance(
                recipient.publicKey,
                "confirmed",
            );

            await program.methods
                .executeSolProposal()
                .accounts({
                    executor: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: solProposalPda,
                    recipient: recipient.publicKey,
                    priceUpdate: null,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const vaultAfter = await connection.getBalance(
                vaultPda,
                "confirmed",
            );
            const recipientAfter = await connection.getBalance(
                recipient.publicKey,
                "confirmed",
            );

            expect(vaultBefore - vaultAfter).to.equal(LAMPORTS_PER_SOL);
            expect(recipientAfter - recipientBefore).to.equal(LAMPORTS_PER_SOL);

            const prop = await program.account.proposal.fetch(solProposalPda);
            expect(prop.status).to.deep.equal({ executed: {} });
        });

        it("fails when proposal is not Approved (already Executed)", async () => {
            await expectError(
                () =>
                    program.methods
                        .executeSolProposal()
                        .accounts({
                            executor: signer1.publicKey,
                            vaultConfig: vaultPda,
                            proposal: solProposalPda,
                            recipient: recipient.publicKey,
                            priceUpdate: null,
                            systemProgram: SystemProgram.programId,
                        })
                        .rpc(),
                "ProposalNotActive", // or a constraint error since status != Approved
            );
        });

        it("fails when non-signer tries to execute", async () => {
            // Create + fully approve a fresh proposal for this test
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL / 10),
                    { sol: {} },
                    "Non-signer execute test",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await program.methods
                .approveProposal()
                .accounts({
                    signer: signer2.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pda,
                })
                .signers([signer2])
                .rpc();

            await expectError(
                () =>
                    program.methods
                        .executeSolProposal()
                        .accounts({
                            executor: nonSigner.publicKey,
                            vaultConfig: vaultPda,
                            proposal: pda,
                            recipient: recipient.publicKey,
                            priceUpdate: null,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([nonSigner])
                        .rpc(),
                "UnauthorizedSigner",
            );
        });

        it("fails when vault has insufficient SOL balance", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);
            const hugeAmount = 999_999 * LAMPORTS_PER_SOL;

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(hugeAmount),
                    { sol: {} },
                    "Too much SOL",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await program.methods
                .approveProposal()
                .accounts({
                    signer: signer2.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pda,
                })
                .signers([signer2])
                .rpc();

            await expectError(
                () =>
                    program.methods
                        .executeSolProposal()
                        .accounts({
                            executor: signer1.publicKey,
                            vaultConfig: vaultPda,
                            proposal: pda,
                            recipient: recipient.publicKey,
                            priceUpdate: null,
                            systemProgram: SystemProgram.programId,
                        })
                        .rpc(),
                "InsufficientBalance",
            );
        });
    });

    // ------- execute_token_proposal -------
    describe("execute_token_proposal", () => {
        // splProposalPda (proposal 1) is Approved: 100k tokens to recipient

        it("executes approved SPL token transfer", async () => {
            const vaultAta = getAssociatedTokenAddressSync(
                testMint,
                vaultPda,
                true,
            );
            const recipientAta = getAssociatedTokenAddressSync(
                testMint,
                recipient.publicKey,
            );
            const vaultBefore = await getAccount(connection, vaultAta);
            const transferAmount = 100_000 * 10 ** TOKEN_DECIMALS;

            await program.methods
                .executeTokenProposal()
                .accounts({
                    executor: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: splProposalPda,
                    recipient: recipient.publicKey,
                    mint: testMint,
                    vaultAta: vaultAta,
                    recipientAta: recipientAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    priceUpdate: null,
                })
                .rpc();

            const vaultAfter = await getAccount(connection, vaultAta);
            const recipientAcct = await getAccount(connection, recipientAta);

            expect(
                Number(vaultBefore.amount) - Number(vaultAfter.amount),
            ).to.equal(transferAmount);
            expect(Number(recipientAcct.amount)).to.equal(transferAmount);

            const prop = await program.account.proposal.fetch(splProposalPda);
            expect(prop.status).to.deep.equal({ executed: {} });
        });

        it("fails with insufficient token balance", async () => {
            const proposalId = await fetchProposalCount();
            const [pda] = getProposalPda(vaultPda, proposalId);
            const hugeTokenAmount = 999_999_999 * 10 ** TOKEN_DECIMALS;

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(hugeTokenAmount),
                    { splToken: { mint: testMint } },
                    "Too many tokens",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await program.methods
                .approveProposal()
                .accounts({
                    signer: signer2.publicKey,
                    vaultConfig: vaultPda,
                    proposal: pda,
                })
                .signers([signer2])
                .rpc();

            const vaultAta = getAssociatedTokenAddressSync(
                testMint,
                vaultPda,
                true,
            );
            const recipientAta = getAssociatedTokenAddressSync(
                testMint,
                recipient.publicKey,
            );

            await expectError(
                () =>
                    program.methods
                        .executeTokenProposal()
                        .accounts({
                            executor: signer1.publicKey,
                            vaultConfig: vaultPda,
                            proposal: pda,
                            recipient: recipient.publicKey,
                            mint: testMint,
                            vaultAta: vaultAta,
                            recipientAta: recipientAta,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                            priceUpdate: null,
                        })
                        .rpc(),
                "InsufficientBalance",
            );
        });
    });

    // ------- cancel_proposal -------
    describe("cancel_proposal", () => {
        let cancelProposalPda: PublicKey;
        let cancelProposalPda2: PublicKey;

        before(async () => {
            // Create two proposals for cancel tests
            const id1 = await fetchProposalCount();
            [cancelProposalPda] = getProposalPda(vaultPda, id1);
            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL / 10),
                    { sol: {} },
                    "Will be cancelled",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: cancelProposalPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const id2 = await fetchProposalCount();
            [cancelProposalPda2] = getProposalPda(vaultPda, id2);
            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL / 10),
                    { sol: {} },
                    "Non-proposer cancel test",
                    null,
                )
                .accounts({
                    proposer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: cancelProposalPda2,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        });

        it("proposer cancels an Active proposal", async () => {
            await program.methods
                .cancelProposal()
                .accounts({
                    signer: signer1.publicKey,
                    vaultConfig: vaultPda,
                    proposal: cancelProposalPda,
                })
                .rpc();

            const prop =
                await program.account.proposal.fetch(cancelProposalPda);
            expect(prop.status).to.deep.equal({ cancelled: {} });
        });

        it("fails when non-proposer tries to cancel", async () => {
            await expectError(
                () =>
                    program.methods
                        .cancelProposal()
                        .accounts({
                            signer: signer2.publicKey,
                            vaultConfig: vaultPda,
                            proposal: cancelProposalPda2,
                        })
                        .signers([signer2])
                        .rpc(),
                "NotProposer",
            );
        });

        it("fails when proposal is not Active (already Cancelled)", async () => {
            await expectError(
                () =>
                    program.methods
                        .cancelProposal()
                        .accounts({
                            signer: signer1.publicKey,
                            vaultConfig: vaultPda,
                            proposal: cancelProposalPda,
                        })
                        .rpc(),
                "ProposalNotActive",
            );
        });
    });

    // =========================================================
    //  PHASE 2 -- PYTH ORACLE PRICE GATE
    // =========================================================

    describe("Phase 2: Pyth Oracle Price Gate", () => {
        // --- Localnet tests (no real Pyth program needed) ---

        describe("proposals without price condition", () => {
            it("executes normally when price_condition is None", async () => {
                // Create + approve a fresh proposal with no price condition
                const proposalId = await fetchProposalCount();
                const [pda] = getProposalPda(vaultPda, proposalId);

                await program.methods
                    .createProposal(
                        recipient.publicKey,
                        new BN(LAMPORTS_PER_SOL / 10),
                        { sol: {} },
                        "No price gate",
                        null,
                    )
                    .accounts({
                        proposer: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                    })
                    .signers([signer2])
                    .rpc();

                const recipientBefore = await connection.getBalance(
                    recipient.publicKey,
                    "confirmed",
                );

                await program.methods
                    .executeSolProposal()
                    .accounts({
                        executor: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        recipient: recipient.publicKey,
                        priceUpdate: null, // no condition, no account needed
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                const recipientAfter = await connection.getBalance(
                    recipient.publicKey,
                    "confirmed",
                );
                expect(recipientAfter - recipientBefore).to.equal(
                    LAMPORTS_PER_SOL / 10,
                );
            });
        });

        describe("proposals with price condition", () => {
            it("fails when price_condition is set but no price_update account provided", async () => {
                // Approve pricedProposalPda (proposal 2) first
                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pricedProposalPda,
                    })
                    .signers([signer2])
                    .rpc();

                // Try to execute without a price_update account
                await expectError(
                    () =>
                        program.methods
                            .executeSolProposal()
                            .accounts({
                                executor: signer1.publicKey,
                                vaultConfig: vaultPda,
                                proposal: pricedProposalPda,
                                recipient: recipient.publicKey,
                                priceUpdate: null,
                                systemProgram: SystemProgram.programId,
                            })
                            .rpc(),
                    "PriceConditionNotMet",
                );
            });
        });

        // --- Devnet tests (require real Pyth price feeds) ---
        // Set CLUSTER=devnet to enable these tests:
        //   CLUSTER=devnet anchor test --provider.cluster devnet
        const isDevnet = process.env.CLUSTER === "devnet";

        describe("Devnet: live price validation", function () {
            before(function () {
                if (!isDevnet) {
                    console.log(
                        "    Skipping devnet Pyth tests. Run with CLUSTER=devnet to enable.",
                    );
                    this.skip();
                }
            });

            // NOTE: These tests require:
            // 1. A deployed program on devnet
            // 2. The @pythnetwork/pyth-solana-receiver package
            // 3. Fresh price update accounts fetched via Hermes
            //
            // Example setup in before():
            //   const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");
            //   const { HermesClient } = require("@pythnetwork/hermes-client");
            //   const hermes = new HermesClient("https://hermes.pyth.network");
            //   const pythReceiver = new PythSolanaReceiver({ connection, wallet });
            //   const priceUpdateAccount = await pythReceiver.fetchPriceUpdateAccount(feedId);

            it("executes when SOL/USD price >= min_price", async () => {
                // 1. Create proposal with min_price set below current SOL price
                // 2. Fetch fresh PriceUpdateV2 account from Pyth
                // 3. Execute with price_update account
                // 4. Verify execution succeeds and status = Executed
                const proposalId = await fetchProposalCount();
                const [pda] = getProposalPda(vaultPda, proposalId);

                // Use a very low min_price so the test passes with current market price
                await program.methods
                    .createProposal(
                        recipient.publicKey,
                        new BN(LAMPORTS_PER_SOL / 100),
                        { sol: {} },
                        "Pyth: price above min",
                        {
                            feedId: SOL_USD_FEED_ID,
                            minPrice: new BN(1_000_000_000), // $10 -- should always pass
                            maxPrice: null,
                            maxAgeSecs: new BN(60),
                        },
                    )
                    .accounts({
                        proposer: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                    })
                    .signers([signer2])
                    .rpc();

                // Fetch price update account (requires Pyth receiver on devnet)
                const { PythSolanaReceiver } = await import(
                    "@pythnetwork/pyth-solana-receiver"
                );
                const pythReceiver = new PythSolanaReceiver({
                    connection,
                    wallet: wallet as any,
                });
                const feedIdHex =
                    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
                const priceUpdateAccount =
                    await pythReceiver.fetchPriceUpdateAccount(feedIdHex);

                await program.methods
                    .executeSolProposal()
                    .accounts({
                        executor: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        recipient: recipient.publicKey,
                        priceUpdate: priceUpdateAccount,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                const prop = await program.account.proposal.fetch(pda);
                expect(prop.status).to.deep.equal({ executed: {} });
            });

            it("fails when SOL/USD price < min_price", async () => {
                const proposalId = await fetchProposalCount();
                const [pda] = getProposalPda(vaultPda, proposalId);

                // Set min_price absurdly high so it always fails
                await program.methods
                    .createProposal(
                        recipient.publicKey,
                        new BN(LAMPORTS_PER_SOL / 100),
                        { sol: {} },
                        "Pyth: price below min",
                        {
                            feedId: SOL_USD_FEED_ID,
                            minPrice: new BN(999_999_000_000_000), // $9,999,990 -- unreachable
                            maxPrice: null,
                            maxAgeSecs: new BN(60),
                        },
                    )
                    .accounts({
                        proposer: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                    })
                    .signers([signer2])
                    .rpc();

                const { PythSolanaReceiver } = await import(
                    "@pythnetwork/pyth-solana-receiver"
                );
                const pythReceiver = new PythSolanaReceiver({
                    connection,
                    wallet: wallet as any,
                });
                const feedIdHex =
                    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
                const priceUpdateAccount =
                    await pythReceiver.fetchPriceUpdateAccount(feedIdHex);

                await expectError(
                    () =>
                        program.methods
                            .executeSolProposal()
                            .accounts({
                                executor: signer1.publicKey,
                                vaultConfig: vaultPda,
                                proposal: pda,
                                recipient: recipient.publicKey,
                                priceUpdate: priceUpdateAccount,
                                systemProgram: SystemProgram.programId,
                            })
                            .rpc(),
                    "PriceConditionNotMet",
                );
            });

            it("fails when SOL/USD price > max_price", async () => {
                const proposalId = await fetchProposalCount();
                const [pda] = getProposalPda(vaultPda, proposalId);

                // Set max_price absurdly low so it always fails
                await program.methods
                    .createProposal(
                        recipient.publicKey,
                        new BN(LAMPORTS_PER_SOL / 100),
                        { sol: {} },
                        "Pyth: price above max",
                        {
                            feedId: SOL_USD_FEED_ID,
                            minPrice: null,
                            maxPrice: new BN(100_000_000), // $1 -- SOL is way above this
                            maxAgeSecs: new BN(60),
                        },
                    )
                    .accounts({
                        proposer: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                    })
                    .signers([signer2])
                    .rpc();

                const { PythSolanaReceiver } = await import(
                    "@pythnetwork/pyth-solana-receiver"
                );
                const pythReceiver = new PythSolanaReceiver({
                    connection,
                    wallet: wallet as any,
                });
                const feedIdHex =
                    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
                const priceUpdateAccount =
                    await pythReceiver.fetchPriceUpdateAccount(feedIdHex);

                await expectError(
                    () =>
                        program.methods
                            .executeSolProposal()
                            .accounts({
                                executor: signer1.publicKey,
                                vaultConfig: vaultPda,
                                proposal: pda,
                                recipient: recipient.publicKey,
                                priceUpdate: priceUpdateAccount,
                                systemProgram: SystemProgram.programId,
                            })
                            .rpc(),
                    "PriceConditionNotMet",
                );
            });

            it("fails when wrong feed ID is passed in price_update", async () => {
                const proposalId = await fetchProposalCount();
                const [pda] = getProposalPda(vaultPda, proposalId);

                // Proposal expects SOL/USD feed
                await program.methods
                    .createProposal(
                        recipient.publicKey,
                        new BN(LAMPORTS_PER_SOL / 100),
                        { sol: {} },
                        "Pyth: wrong feed",
                        {
                            feedId: SOL_USD_FEED_ID,
                            minPrice: new BN(1_000_000_000), // $10
                            maxPrice: null,
                            maxAgeSecs: new BN(60),
                        },
                    )
                    .accounts({
                        proposer: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                    })
                    .signers([signer2])
                    .rpc();

                // Pass BTC/USD price account instead of SOL/USD
                const { PythSolanaReceiver } = await import(
                    "@pythnetwork/pyth-solana-receiver"
                );
                const pythReceiver = new PythSolanaReceiver({
                    connection,
                    wallet: wallet as any,
                });
                const btcFeedId =
                    "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
                const wrongPriceUpdate =
                    await pythReceiver.fetchPriceUpdateAccount(btcFeedId);

                await expectError(
                    () =>
                        program.methods
                            .executeSolProposal()
                            .accounts({
                                executor: signer1.publicKey,
                                vaultConfig: vaultPda,
                                proposal: pda,
                                recipient: recipient.publicKey,
                                priceUpdate: wrongPriceUpdate,
                                systemProgram: SystemProgram.programId,
                            })
                            .rpc(),
                    "PriceConditionNotMet",
                );
            });

            it("fails when price feed data is stale", async () => {
                const proposalId = await fetchProposalCount();
                const [pda] = getProposalPda(vaultPda, proposalId);

                // Set max_age_secs to 0 so any real price is "stale"
                await program.methods
                    .createProposal(
                        recipient.publicKey,
                        new BN(LAMPORTS_PER_SOL / 100),
                        { sol: {} },
                        "Pyth: stale price",
                        {
                            feedId: SOL_USD_FEED_ID,
                            minPrice: new BN(1_000_000_000),
                            maxPrice: null,
                            maxAgeSecs: new BN(0), // zero tolerance = always stale
                        },
                    )
                    .accounts({
                        proposer: signer1.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

                await program.methods
                    .approveProposal()
                    .accounts({
                        signer: signer2.publicKey,
                        vaultConfig: vaultPda,
                        proposal: pda,
                    })
                    .signers([signer2])
                    .rpc();

                const { PythSolanaReceiver } = await import(
                    "@pythnetwork/pyth-solana-receiver"
                );
                const pythReceiver = new PythSolanaReceiver({
                    connection,
                    wallet: wallet as any,
                });
                const feedIdHex =
                    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
                const priceUpdateAccount =
                    await pythReceiver.fetchPriceUpdateAccount(feedIdHex);

                await expectError(
                    () =>
                        program.methods
                            .executeSolProposal()
                            .accounts({
                                executor: signer1.publicKey,
                                vaultConfig: vaultPda,
                                proposal: pda,
                                recipient: recipient.publicKey,
                                priceUpdate: priceUpdateAccount,
                                systemProgram: SystemProgram.programId,
                            })
                            .rpc(),
                    "StalePriceFeed",
                );
            });
        });
    });
});
