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
    pub feed_id: [u8; 32],
    pub min_price: Option<i64>,
    pub max_price: Option<i64>,
    pub max_age_secs: u64,
}
