# Multisig Vault

A Solana program for managing shared funds with threshold-based approvals. Built with Anchor.

**Devnet Program ID:** [`EL9AsYrsmVDm4HTd7dCWnJJgadksCGkJfyFCw4WTfaZp`](https://explorer.solana.com/address/EL9AsYrsmVDm4HTd7dCWnJJgadksCGkJfyFCw4WTfaZp?cluster=devnet)

## Overview

Multisig Vault lets a group of signers collectively control a treasury. Transfers require a configurable number of approvals (M-of-N) before execution. Supports both native SOL and SPL token transfers.

Proposals can optionally include Pyth oracle price conditions, gating execution on an asset price falling within a specified range.

## Architecture

```mermaid
graph TD
    S1[Signer 1] --> V[Vault Config<br/>M-of-N Threshold]
    S2[Signer 2] --> V
    S3[Signer N] --> V

    V --> T[Treasury PDA<br/>SOL + SPL Tokens]
    V --> P[Proposal]

    P --> |approve >= threshold| A[Approved]
    P --> |rejections block threshold| R[Rejected]
    A --> |execute| TX[Transfer to Recipient]
    TX --> |optional| PY[Pyth Price Check]

    D1[Deposit SOL] --> T
    D2[Deposit Token] --> T
```

## Proposal Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Active: create_proposal
    Active --> Approved: approvals >= threshold
    Active --> Rejected: threshold unreachable
    Active --> Cancelled: proposer cancels
    Approved --> Executed: execute_sol / execute_token
```

A proposal transitions to **Approved** once the approval count reaches the vault threshold. It transitions to **Rejected** when enough signers have rejected that the threshold can no longer be reached. The proposer can **Cancel** their own proposal at any time while it is still active.

