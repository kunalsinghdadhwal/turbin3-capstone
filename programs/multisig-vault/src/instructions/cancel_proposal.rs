use crate::constants::*;
use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault_config.creator.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, vault_config.key().as_ref(), proposal.proposal_id.to_le_bytes().as_ref()],
        bump = proposal.bump,
        constraint = proposal.vault == vault_config.key() @ VaultError::NotProposer,
    )]
    pub proposal: Account<'info, Proposal>,
}

pub fn handler(ctx: Context<CancelProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;

    require!(
        proposal.status == ProposalStatus::Active,
        VaultError::ProposalNotActive
    );
    require!(
        proposal.proposer == ctx.accounts.signer.key(),
        VaultError::NotProposer
    );

    proposal.status = ProposalStatus::Cancelled;

    Ok(())
}
