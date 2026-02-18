use crate::constants::*;
use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ApproveProposal<'info> {
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

pub fn handler(ctx: Context<ApproveProposal>) -> Result<()> {
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

    proposal.approvals.push(signer_key);

    if proposal.approvals.len() as u8 >= vault.threshold {
        proposal.status = ProposalStatus::Approved;
    }

    Ok(())
}
