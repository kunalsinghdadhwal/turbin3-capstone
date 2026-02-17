pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EL9AsYrsmVDm4HTd7dCWnJJgadksCGkJfyFCw4WTfaZp");

#[program]
pub mod multisig_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, signers: Vec<Pubkey>, threshold: u8) -> Result<()> {
        instructions::initialize::handler(ctx, signers, threshold)
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        instructions::deposit_sol::handler(ctx, amount)
    }

    pub fn deposit_token(ctx: Context<DepositToken>, amount: u64) -> Result<()> {
        instructions::deposit_token::handler(ctx, amount)
    }

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        recipient: Pubkey,
        amount: u64,
        transfer_type: TransferType,
        description: String,
        price_condition: Option<PriceCondition>,
    ) -> Result<()> {
        instructions::create_proposal::handler(
            ctx,
            recipient,
            amount,
            transfer_type,
            description,
            price_condition,
        )
    }

    pub fn approve_proposal(ctx: Context<ApproveProposal>) -> Result<()> {
        instructions::approve_proposal::handler(ctx)
    }

    pub fn reject_proposal(ctx: Context<RejectProposal>) -> Result<()> {
        instructions::reject_proposal::handler(ctx)
    }

    pub fn execute_sol_proposal(ctx: Context<ExecuteSolProposal>) -> Result<()> {
        instructions::execute_sol_proposal::handler(ctx)
    }

    pub fn execute_token_proposal(ctx: Context<ExecuteTokenProposal>) -> Result<()> {
        instructions::execute_token_proposal::handler(ctx)
    }

    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        instructions::cancel_proposal::handler(ctx)
    }
}
