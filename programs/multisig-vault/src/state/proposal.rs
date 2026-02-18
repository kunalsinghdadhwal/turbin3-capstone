use crate::constants::*;
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub vault: Pubkey,
    pub proposal_id: u64,
    pub proposer: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub transfer_type: TransferType,
    #[max_len(MAX_DESCRIPTION_LEN)]
    pub description: String,
    pub price_condition: Option<PriceCondition>,
    #[max_len(MAX_SIGNERS)]
    pub approvals: Vec<Pubkey>,
    #[max_len(MAX_SIGNERS)]
    pub rejections: Vec<Pubkey>,
    pub status: ProposalStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum ProposalStatus {
    Active,
    Approved,
    Executed,
    Rejected,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum TransferType {
    Sol,
    SplToken { mint: Pubkey },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub struct PriceCondition {
    pub feed: Pubkey,              // Switchboard pull feed account
    pub min_price: Option<i64>,    // price scaled to 8 decimals (e.g. 15_000_000_000 = $150)
    pub max_price: Option<i64>,    // price scaled to 8 decimals
    pub max_stale_slots: u64,      // maximum staleness in slots
}
