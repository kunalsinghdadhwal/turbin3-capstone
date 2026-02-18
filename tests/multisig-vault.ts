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

    const signer1 = wallet.payer;
    const signer2 = Keypair.generate();
    const signer3 = Keypair.generate();
    const nonSigner = Keypair.generate();
    const recipient = Keypair.generate();

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

    async function airdrop(to: PublicKey, sol: number) {
        const sig = await connection.requestAirdrop(
            to,
            sol * LAMPORTS_PER_SOL,
        );
        await connection.confirmTransaction(sig, "confirmed");
    }

    async function fetchProposalCount(): Promise<number> {
        const v = await program.account.vaultConfig.fetch(vaultPda);
        return v.proposalCount.toNumber();
    }

    const signersList = [
        signer1.publicKey,
        signer2.publicKey,
        signer3.publicKey,
    ];
    const threshold = 2;
    const [vaultPda] = getVaultPda(signer1.publicKey);

    let testMint: PublicKey;
    const TOKEN_DECIMALS = 6;
    const MINT_AMOUNT = 1_000_000 * 10 ** TOKEN_DECIMALS;

    let solProposalPda: PublicKey;
    let splProposalPda: PublicKey;

    before(async () => {
        await Promise.all([
            airdrop(signer2.publicKey, 5),
            airdrop(signer3.publicKey, 5),
            airdrop(nonSigner.publicKey, 5),
            airdrop(recipient.publicKey, 1),
        ]);
    });

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
            expect(vault.threshold).to.equal(2);
            expect(vault.proposalCount.toNumber()).to.equal(0);
        });
    });

    // ------- deposit_sol -------
    describe("deposit_sol", () => {
        it("deposits SOL into the vault", async () => {
            const before = await connection.getBalance(vaultPda, "confirmed");

            const sig = await program.methods
                .depositSol(new BN(2 * LAMPORTS_PER_SOL))
                .accounts({
                    depositor: signer1.publicKey,
                    vaultConfig: vaultPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            await connection.confirmTransaction(sig, "confirmed");

            const after = await connection.getBalance(vaultPda, "confirmed");
            expect(after - before).to.equal(2 * LAMPORTS_PER_SOL);
        });
    });

    // ------- deposit_token -------
    describe("deposit_token", () => {
        before(async () => {
            testMint = await createMint(
                connection,
                wallet.payer,
                signer1.publicKey,
                null,
                TOKEN_DECIMALS,
            );

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
                signer1,
                MINT_AMOUNT,
            );
        });

        it("deposits SPL tokens into vault ATA", async () => {
            const depositorAta = getAssociatedTokenAddressSync(
                testMint,
                signer1.publicKey,
            );
            const vaultAta = getAssociatedTokenAddressSync(
                testMint,
                vaultPda,
                true,
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
    });

    // ------- create_proposal -------
    describe("create_proposal", () => {
        it("creates a SOL withdrawal proposal", async () => {
            const proposalId = await fetchProposalCount();
            [solProposalPda] = getProposalPda(vaultPda, proposalId);

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL),
                    { sol: {} },
                    "Pay contributor",
                    null,
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
            expect(prop.recipient.equals(recipient.publicKey)).to.be.true;
            expect(prop.amount.toNumber()).to.equal(LAMPORTS_PER_SOL);
            expect(prop.status).to.deep.equal({ active: {} });
            expect(prop.approvals).to.have.lengthOf(1);
            expect(prop.approvals[0].equals(signer1.publicKey)).to.be.true;
        });

        it("creates an SPL token withdrawal proposal", async () => {
            const proposalId = await fetchProposalCount();
            [splProposalPda] = getProposalPda(vaultPda, proposalId);

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
    });

    // ------- approve_proposal -------
    describe("approve_proposal", () => {
        it("second signer approves SOL proposal, reaching threshold", async () => {
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
            expect(prop.status).to.deep.equal({ approved: {} });
        });

        it("approves SPL proposal to threshold", async () => {
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
        let rejectProposalPda: PublicKey;

        before(async () => {
            const proposalId = await fetchProposalCount();
            [rejectProposalPda] = getProposalPda(vaultPda, proposalId);

            await program.methods
                .createProposal(
                    recipient.publicKey,
                    new BN(LAMPORTS_PER_SOL),
                    { sol: {} },
                    "Proposal to reject",
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
            expect(prop.status).to.deep.equal({ active: {} });
        });

        it("auto-rejects when threshold can no longer be met", async () => {
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
        it("executes approved SOL proposal, transfers to recipient", async () => {
            const recipientBefore = await connection.getBalance(
                recipient.publicKey,
                "confirmed",
            );

            const sig = await program.methods
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
            await connection.confirmTransaction(sig, "confirmed");

            const recipientAfter = await connection.getBalance(
                recipient.publicKey,
                "confirmed",
            );
            expect(recipientAfter - recipientBefore).to.equal(LAMPORTS_PER_SOL);

            const prop = await program.account.proposal.fetch(solProposalPda);
            expect(prop.status).to.deep.equal({ executed: {} });
        });
    });

    // ------- execute_token_proposal -------
    describe("execute_token_proposal", () => {
        it("executes approved SPL token proposal", async () => {
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
    });

    // ------- cancel_proposal -------
    describe("cancel_proposal", () => {
        let cancelProposalPda: PublicKey;

        before(async () => {
            const id = await fetchProposalCount();
            [cancelProposalPda] = getProposalPda(vaultPda, id);
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
        });

        it("proposer cancels an active proposal", async () => {
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
    });
});
