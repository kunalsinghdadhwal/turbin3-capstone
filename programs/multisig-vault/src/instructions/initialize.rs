use crate::constants::*;
use crate::error::VaultError;
use crate::state::VaultConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [VAULT_SEED, creator.key().as_ref()],
        bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, signers: Vec<Pubkey>, threshold: u8) -> Result<()> {
    require!(
        !signers.is_empty() && threshold >= 1 && threshold <= signers.len() as u8,
        VaultError::InvalidThreshold
    );
    require!(signers.len() <= MAX_SIGNERS, VaultError::TooManySigners);

    let mut sorted = signers.clone();
    sorted.sort();

    for i in 1..sorted.len() {
        require!(sorted[i] != sorted[i - 1], VaultError::DuplicateSigner);
    }

    let vault = &mut ctx.accounts.vault_config;
    vault.creator = ctx.accounts.creator.key();
    vault.signers = signers;
    vault.threshold = threshold;
    vault.proposal_cnt = 0;
    vault.bump = ctx.bumps.vault_config;

    Ok(())
}
