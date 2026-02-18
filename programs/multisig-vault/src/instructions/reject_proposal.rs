use crate::constants::*;
use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RejectProposal<'info> {
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
        constraint = proposal.vault == vault_config.key() @ VaultError::UnauthorizedSigner,
    )]
    pub proposal: Account<'info, Proposal>,
}

pub fn handler(ctx: Context<RejectProposal>) -> Result<()> {
    let vault = &ctx.accounts.vault_config;
    let proposal = &mut ctx.accounts.proposal;
    let signer_key = ctx.accounts.signer.key();

    require!(
        proposal.status == ProposalStatus::Active,
        VaultError::ProposalNotActive
    );
    require!(
        vault.signers.contains(&signer_key),
        VaultError::UnauthorizedSigner
    );
    require!(
        !proposal.approvals.contains(&signer_key) && !proposal.rejections.contains(&signer_key),
        VaultError::AlreadyVoted
    );

    proposal.rejections.push(signer_key);

    // Auto-reject: if remaining unvoted signers + current approvals < threshold,
    // the threshold can never be met.
    let total_voted = proposal.approvals.len() + proposal.rejections.len();
    let remaining = vault.signers.len() - total_voted;
    if (proposal.approvals.len() + remaining) < vault.threshold as usize {
        proposal.status = ProposalStatus::Rejected;
    }

    Ok(())
}
