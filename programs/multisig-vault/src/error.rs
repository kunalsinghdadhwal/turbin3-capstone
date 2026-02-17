use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Number of signers exceeds maximum")]
    TooManySigners,
    #[msg("Threshold must be > 0 and <= number of signers")]
    InvalidThreshold,
    #[msg("Signer is not authorized for this vault")]
    UnauthorizedSigner,
    #[msg("Signer has already voted on this proposal")]
    AlreadyVoted,
    #[msg("Proposal is not in Active status")]
    ProposalNotActive,
    #[msg("Approval threshold not yet met")]
    ThresholdNotMet,
    #[msg("Proposal has already been executed")]
    AlreadyExecuted,
    #[msg("Only the proposer can cancel")]
    NotProposer,
    #[msg("Description too long")]
    DescriptionTooLong,
    #[msg("Insufficient vault balance")]
    InsufficientBalance,
    #[msg("Duplicate signer in list")]
    DuplicateSigner,
    // Phase 2
    #[msg("Price condition not met")]
    PriceConditionNotMet,
    #[msg("Price feed is stale")]
    StalePriceFeed,
}
