use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ExecuteSolProposal<'info> {
    pub executor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.creator.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, vault_config.key().as_ref(), proposal.proposal_id.to_le_bytes().as_ref()],
        bump = proposal.bump,
        has_one = vault,
    )]
    pub proposal: Account<'info, Proposal>,

    /// CHECK: validated against proposal.recipient in handler
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: optional Pyth price update account
    pub price_update: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<ExecuteSolProposal>) -> Result<()> {
    // TODO: implement
    Ok(())
}
