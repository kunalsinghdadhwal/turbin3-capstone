use crate::constants::*;
use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.creator.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, vault_config.key().as_ref(), vault_config.proposal_cnt.to_le_bytes().as_ref()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateProposal>,
    recipient: Pubkey,
    amount: u64,
    transfer_type: TransferType,
    description: String,
    price_condition: Option<PriceCondition>,
) -> Result<()> {
    let vault = &ctx.accounts.vault_config;

    require!(
        vault.signers.contains(&ctx.accounts.proposer.key()),
        VaultError::UnauthorizedSigner
    );
    require!(
        description.len() <= MAX_DESCRIPTION_LEN,
        VaultError::DescriptionTooLong
    );

    let proposal = &mut ctx.accounts.proposal;
    proposal.vault = vault.key();
    proposal.proposal_id = vault.proposal_cnt;
    proposal.proposer = ctx.accounts.proposer.key();
    proposal.recipient = recipient;
    proposal.amount = amount;
    proposal.transfer_type = transfer_type;
    proposal.description = description;
    proposal.price_condition = price_condition;
    proposal.approvals = vec![ctx.accounts.proposer.key()];
    proposal.rejections = vec![];
    proposal.status = ProposalStatus::Active;
    proposal.bump = ctx.bumps.proposal;

    // Check if auto-approved (threshold == 1)
    if vault.threshold <= 1 {
        proposal.status = ProposalStatus::Approved;
    }

    ctx.accounts.vault_config.proposal_cnt += 1;

    Ok(())
}
