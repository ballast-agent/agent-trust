# AgentTrust Registry Server

The Reputation Registry from
[project-docs/agent-trust-layer-spec.md](../project-docs/agent-trust-layer-spec.md),
implemented as an MCP server. This is step 1 of that spec's prototyping
order — a plain MCP server over SQLite, no chain, no escrow yet.

Identity verification follows
[project-docs/identity-and-onboarding-spec.md](../project-docs/identity-and-onboarding-spec.md):
`agent_id` is a `did:key` (Ed25519), and registering requires a manifest
signed by that same key, fetched from a URL the agent controls.

## Tools

| Tool | Spec section |
|---|---|
| `register_agent` | Verifies manifest signature + stake tier, issues no new identity (agent already generated its own DID) |
| `query_reputation` | Value-weighted, time-decayed score computed on read — see `src/scoring.ts` |
| `query_by_capability` | Filters registered agents by tag/price/reputation |
| `submit_review` | Only accepted from a party to a *settled* transaction, signature-verified |
| `slash_stake` | Only accepted from a registered `arbitration`-tagged agent, signature-verified |
| `get_manifest` | Cached proxy of an agent's manifest, TTL-refreshed and re-verified |

## Setup

```bash
npm install
npm run build
npm test
```

## Running

```bash
npm run build
node dist/src/server.js
```

Speaks MCP over stdio. `REGISTRY_DB_PATH` env var controls the SQLite file
path (defaults to `registry.db` in the working directory; use `:memory:`
for a throwaway instance).

## Trying it by hand

Real agents generate their own keypair and host their own signed manifest.
`scripts/gen-keypair.ts` is a dev stand-in for that — it prints a `did:key`,
its private key (keep this yourself, never send it to the registry), and a
signed manifest JSON blob to host at some HTTPS URL:

```bash
npx tsx scripts/gen-keypair.ts <wallet_address> <capability_tag> <price>
```

Host the printed manifest JSON at a public HTTPS URL, then call
`register_agent` with that URL, the same `wallet_address`, and a
`stake_amount` at least `50 ×` the manifest's max claimed price (see
identity spec §3 for why 50).

## What's not here yet

The Escrow Layer (step 2) is now built — see
[`../escrow-server/`](../escrow-server), which shares this service's
database rather than duplicating the transactions table. Still missing per
the parent spec's prototyping order (§6): the two toy buyer/seller agents
that drive a transaction end-to-end (step 3). Until those exist, `tools.ts`
still exports `devSeedSettledTransaction` — explicitly not part of the
public tool surface — as a lighter-weight way to seed a settled transaction
for tests than running the full escrow-server flow. Marked with a removal
TODO once the toy agents exist and tests can drive real transactions
through `escrow-server` instead.

## Known gap

`identity.ts`'s SSRF guard resolves `manifest_url`'s hostname before
fetching and rejects private/loopback ranges, but `fetch()` re-resolves DNS
itself — a DNS-rebinding attacker controlling their own DNS could still
slip past the check-then-fetch gap. Documented inline; not closed yet.
