use crate::constants::MAX_SIGNERS;
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub creator: Pubkey,
    #[max_len(MAX_SIGNERS)]
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub proposal_count: u64,
    pub bump: u8,
}
