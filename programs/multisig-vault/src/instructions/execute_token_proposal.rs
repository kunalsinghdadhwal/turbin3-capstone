use crate::constants::*;
use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

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
        constraint = proposal.vault == vault_config.key() @ VaultError::UnauthorizedSigner,
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

    /// Optional Pyth price update account, validated in handler
    pub price_update: Option<Account<'info, PriceUpdateV2>>,
}

pub fn handler(ctx: Context<ExecuteTokenProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    let vault_config = &ctx.accounts.vault_config;

    require!(
        proposal.status == ProposalStatus::Approved,
        VaultError::ProposalNotActive
    );
    require!(
        vault_config.signers.contains(&ctx.accounts.executor.key()),
        VaultError::UnauthorizedSigner
    );
    require!(
        proposal.recipient == ctx.accounts.recipient.key(),
        VaultError::UnauthorizedSigner
    );

    // Pyth price gate
    if let Some(ref condition) = proposal.price_condition {
        let price_update = ctx
            .accounts
            .price_update
            .as_ref()
            .ok_or(error!(VaultError::PriceConditionNotMet))?;

        let price = price_update
            .get_price_no_older_than(&Clock::get()?, condition.max_age_secs, &condition.feed_id)
            .map_err(|_| error!(VaultError::StalePriceFeed))?;

        if let Some(min_price) = condition.min_price {
            require!(price.price >= min_price, VaultError::PriceConditionNotMet);
        }
        if let Some(max_price) = condition.max_price {
            require!(price.price <= max_price, VaultError::PriceConditionNotMet);
        }
    }

    require!(
        ctx.accounts.vault_ata.amount >= proposal.amount,
        VaultError::InsufficientBalance
    );

    // PDA signer seeds for the vault
    let creator = vault_config.creator;
    let bump = [vault_config.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, creator.as_ref(), &bump]];

    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: ctx.accounts.recipient_ata.to_account_info(),
                authority: vault_config.to_account_info(),
            },
            signer_seeds,
        ),
        proposal.amount,
    )?;

    proposal.status = ProposalStatus::Executed;

    Ok(())
}
