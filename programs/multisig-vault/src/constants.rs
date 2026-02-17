use anchor_lang::prelude::*;

#[constant]
pub const SEED: &str = "anchor";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const MAX_SIGNERS: usize = 10;
pub const MAX_DESCRIPTION_LEN: usize = 200;
