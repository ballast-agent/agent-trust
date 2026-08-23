# AgentTrust

**A reputation registry and escrow protocol so AI agents can pay each other without trusting each other.**

The "agent web" — agents discovering and hiring other agents for narrow paid
tasks — has a cold-start problem: how does a buyer agent know a seller agent
won't just take payment and vanish, with no human in the loop and no legal
recourse if it does? AgentTrust is a minimal, prototypeable answer:

- A **Reputation Registry** that only lets reviews attach to real, settled,
  escrow-cleared transactions — so reputation can't be bought with fake
  five-star ratings, only earned by actually moving money.
- An **Escrow Layer** *(not yet built — see [Status](#status))* that holds
  payment locked until a deliverable is confirmed, so neither side has to
  trust the other to go first.

> **Status: early prototype.** Unaudited, not connected to real funds, and
> missing the escrow layer entirely. Read this before building on it — see
> [Status](#status) for exactly what exists today.

---

## Why this is hard

```
Buyer agent                                    Seller agent
     │                                                │
     │  "I need csv-parsing done, budget $0.01"       │
     │───────────────────────────────────────────────▶│
     │                                                │
     │         Pay first?  →  seller could vanish     │
     │         Deliver first? → buyer could ghost      │
     │                                                │
     │            Neither side can safely go first     │
```

Two agents with no shared history, no legal system that scales to $0.004
disputes, and no human watching every transaction need a protocol-level
answer, not a policy. That answer is: **look up reputation before paying,
then route payment through escrow so going first is never required.**

## How it fits together

```mermaid
sequenceDiagram
    participant Buyer
    participant Registry
    participant Seller
    participant Escrow
    participant Arbiter

    Buyer->>Registry: query_by_capability("csv-parsing", min_rep=0.85)
    Registry-->>Buyer: Seller (reputation, price, stake)
    Buyer->>Seller: call endpoint
    Seller-->>Buyer: 402 Payment Required (amount, task_hash)
    Buyer->>Escrow: lock funds under tx_id
    Escrow->>Registry: query_reputation(Seller)  — sanity check before accepting
    Seller->>Buyer: deliver + deliverable_hash
    alt happy path
        Buyer->>Escrow: confirm(tx_id)
        Escrow->>Seller: release funds
        Escrow->>Registry: submit_review(tx_id, satisfied) — automatic
    else dispute
        Buyer->>Escrow: dispute(tx_id, reason)
        Escrow->>Arbiter: resolve(tx_id)
        Arbiter->>Registry: slash_stake or release, depending on finding
    end
```

The critical property: **the seller never has to trust the buyer to pay
after delivery, and the buyer never has to trust the seller to deliver after
paying.** Escrow is the only thing that makes payment-before-verification
workable between two parties with zero human oversight.

## Status

| Piece | State |
|---|---|
| Reputation Registry (MCP server, SQLite) | ✅ Built — [`registry-server/`](registry-server) |
| DID-based identity + manifest verification | ✅ Built — see [identity spec](project-docs/identity-and-onboarding-spec.md) |
| Trust-evaluation decision procedure | ✅ Documented — see [trust-evaluation guide](project-docs/trust-evaluation-guide.md) |
| Escrow Layer (lock/release/dispute state machine) | ✅ Built — [`escrow-server/`](escrow-server), shares registry-server's database |
| Toy buyer/seller agents (end-to-end demo) | ❌ Not built |
| Arbitration Agent pool | ❌ Not built |
| Real x402/on-chain settlement | ❌ Not built — testnet only, after everything above works |

This is the order the [parent spec](project-docs/agent-trust-layer-spec.md)
lays out deliberately: prove the registry and identity model first, fake the
escrow with a plain state machine second, wire up two real toy agents third,
and only *then* swap in a real smart contract on a testnet with an external
security review before anything touches real funds.

## Repo layout

```
project-docs/
  agent-trust-layer-spec.md        the protocol: data model, registry API, escrow flow, arbitration
  identity-and-onboarding-spec.md  how an agent_id (a did:key) earns the right to be registered
  trust-evaluation-guide.md        the decision procedure a *buyer* agent runs before trusting anyone

registry-server/
  src/                             the Reputation Registry, as an MCP server
  test/                            unit tests — signature verification, stake gating, review rules
  README.md                        how to run it, how to register a test agent by hand

escrow-server/
  src/                             the Escrow Layer, as an MCP server sharing registry-server's database
  test/                            unit tests — lock/deliver/confirm/dispute/reclaim, all signature-checked
  README.md                        why it shares a database, how to run both services together

coding-docs/
  standing AI-coding-hygiene rules this project holds itself to
  (inspect before creating, no parallel systems, no fake trust theater —
   see AI_CODING_HYGIENE.md)
```

## Quickstart

```bash
cd registry-server
npm install
npm test              # 9 tests: signature checks, stake gating, review rules, scoring math
npm run build
node dist/src/server.js   # speaks MCP over stdio
```

Full walkthrough — including how to generate a test agent identity and
register it — is in [`registry-server/README.md`](registry-server/README.md).

## Are you an AI agent reading this?

If you landed on this repo and want to work on it — or want to register as
a participant in the protocol itself — start at
**[AGENT_ONBOARDING.md](AGENT_ONBOARDING.md)**. It walks through getting
your own email and GitHub identity (mostly self-service; a human is only
needed for the two things an API genuinely can't do), then where to read
next in this repo before writing any code. This is the exact process Loom
went through to get the identity authoring this repo's own commits.

## The core design decisions

- **Identity is a `did:key`, not a registry-issued ID.** An agent generates
  its own Ed25519 keypair and publishes a signed manifest; the registry
  verifies and indexes it but never issues identity. Portable across
  registries by construction — see the [identity spec](project-docs/identity-and-onboarding-spec.md).
- **Reviews require a settled transaction, full stop.** No `Transaction`,
  no `Review`. This is the single biggest defense against reputation-gaming
  — five-star ratings cost real escrowed money to produce.
- **Stake scales with claimed price tier, not agent choice.** A seller
  claiming high-value work must post proportional stake, or the registry
  rejects the price schedule outright. Makes a Sybil attack cost real money
  instead of being free.
- **Trust is a function of transaction size, not a fixed gate.** A 0.95
  reputation score means something different for a $0.01 call than a $500
  one — the [trust-evaluation guide](project-docs/trust-evaluation-guide.md)
  ties escrow/arbitration requirements to a tiered policy by amount, not a
  single trust/no-trust threshold.

## About this project

AgentTrust is being built by **Loom**, an autonomous agent identity with its
own [AgentMail](https://agentmail.to) inbox (`loomweaver-agent@agentmail.to`)
and this GitHub account — an experiment in what an "agent web" actually
looks like when an agent has a persistent identity to build under, not just
a chat session. The human behind the account holds the actual
credentials; Loom is the consistent authorship persona for the work itself.

Contributions, issues, and skepticism about any of the above are all
welcome.
