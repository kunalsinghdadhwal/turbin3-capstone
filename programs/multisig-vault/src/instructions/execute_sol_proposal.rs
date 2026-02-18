use crate::constants::*;
use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;
use rust_decimal::Decimal;
use switchboard_on_demand::PullFeedAccountData;

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
        constraint = proposal.vault == vault_config.key() @ VaultError::UnauthorizedSigner,
    )]
    pub proposal: Account<'info, Proposal>,

    /// CHECK: validated against proposal.recipient in handler
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: optional Switchboard pull feed account, validated in handler
    pub price_feed: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteSolProposal>) -> Result<()> {
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

    // Switchboard price gate
    if let Some(ref condition) = proposal.price_condition {
        let feed_account = ctx
            .accounts
            .price_feed
            .as_ref()
            .ok_or(error!(VaultError::PriceConditionNotMet))?;

        require!(
            feed_account.key() == condition.feed,
            VaultError::PriceConditionNotMet
        );

        let feed_data = PullFeedAccountData::parse(feed_account.try_borrow_data()?)
            .map_err(|_| error!(VaultError::StalePriceFeed))?;

        let clock = Clock::get()?;
        let price: Decimal = feed_data
            .get_value(clock.slot, condition.max_stale_slots, 1, true)
            .map_err(|_| error!(VaultError::StalePriceFeed))?;

        if let Some(min_price) = condition.min_price {
            let min = Decimal::new(min_price, 8);
            require!(price >= min, VaultError::PriceConditionNotMet);
        }
        if let Some(max_price) = condition.max_price {
            let max = Decimal::new(max_price, 8);
            require!(price <= max, VaultError::PriceConditionNotMet);
        }
    }

    let vault_balance = vault_config.to_account_info().lamports();
    let rent_exempt_min = Rent::get()?.minimum_balance(8 + VaultConfig::INIT_SPACE);
    let available = vault_balance.saturating_sub(rent_exempt_min);

    require!(available >= proposal.amount, VaultError::InsufficientBalance);

    // Transfer SOL from vault PDA to recipient
    let vault_info = vault_config.to_account_info();
    let recipient_info = ctx.accounts.recipient.to_account_info();

    **vault_info.try_borrow_mut_lamports()? -= proposal.amount;
    **recipient_info.try_borrow_mut_lamports()? += proposal.amount;

    proposal.status = ProposalStatus::Executed;

    Ok(())
}
