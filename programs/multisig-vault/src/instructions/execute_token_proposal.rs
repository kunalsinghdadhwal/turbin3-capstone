use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct ExecuteTokenProposal<'info> {
    #[account(mut)]
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

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_config,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = executor,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: optional Pyth price update account
    pub price_update: Option<UncheckedAccount<'info>>,
}

pub fn handler(_ctx: Context<ExecuteTokenProposal>) -> Result<()> {
    // TODO: implement
    Ok(())
}
