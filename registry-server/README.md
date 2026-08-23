# AgentTrust Registry Server

The Reputation Registry from
[project-docs/agent-trust-layer-spec.md](../project-docs/agent-trust-layer-spec.md),
implemented as an MCP server. This is step 1 of that spec's prototyping
order — a plain MCP server over SQLite, no chain. The Escrow Layer (step 2)
now exists too — see [`../escrow-server/`](../escrow-server).

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

Steps 2 and 3 of the parent spec's prototyping order (§6) are both built
now: the Escrow Layer ([`../escrow-server/`](../escrow-server), sharing
this service's database) and the toy buyer/seller agents
([`../demo/`](../demo), driving a real transaction through both live MCP
servers). This package's own unit tests drive real transactions through
escrow-server's business-logic functions in-process (settled via
create → deliver → confirm, disputed via raise_dispute) rather than
seeding transaction rows directly, so every reviewed/slashed state in the
tests was genuinely earned.

Still missing: step 4, the real x402 smart contract on a testnet, only
after an external security review.

## SSRF hardening

`identity.ts`'s guard resolves `manifest_url`'s hostname exactly once
(`resolveManifestTarget`), rejects private/loopback ranges, and then dials
the pinned address directly (`httpGetPinned`) instead of letting `fetch()`
resolve DNS a second time — closing the check-then-connect TOCTOU window a
DNS-rebinding attacker could previously slip through. TLS SNI and
certificate identity stay bound to the hostname, redirects are still
refused rather than followed, and responses are capped (10s timeout, 1MB)
so an attacker-controlled URL can't hold the registry's resources hostage.

## Rate limits on outbound manifest fetches

Both externally-triggered network paths are rate limited in-process
(`src/ratelimit.ts`, a sliding-window limiter with an injectable clock —
no dependencies, no sleeps in tests):

| Budget | Limit | Why |
| --- | --- | --- |
| Per caller — `wallet_address` at registration, `agent_id` at refetch | 5 fetches / 60s | An honest agent registers once or twice and occasionally retries; 5/min is far above that, but low enough that a loop can't use the registry as a request amplifier. |
| Per target hostname (all callers combined) | 30 fetches / 60s | Caps how hard ANY third-party host can be hit through this registry even when many "callers" collude; still generous for a popular manifest host under honest load. |

Design choices worth knowing:

- Limits fire **before** the outbound fetch is attempted — the point is to
  prevent the network call, not to punish it afterwards. Rejections surface
  as a clear `RegistryError` ("rate limit exceeded for … retry in ~Ns").
- **Rejected attempts don't count** toward the budget, so hammering a full
  key cannot extend its own lockout.
- Cache hits on `get_manifest` never touch the network and stay unlimited;
  only the stale-cache refetch path is limited.
- A cache hit returns the agent's real `sla_seconds` and `signature` from
  its last verified fetch — both are persisted on the `agents` row at
  registration/refetch time (`db.ts`'s `sla_seconds`/`manifest_signature`
  columns), not fabricated. A row from before these columns existed reads
  back `null` for both, which `getManifest` treats as cache-miss-worthy —
  it self-heals via the normal refetch path rather than needing a backfill.
- The limiter is per-process memory. A multi-process deployment would give
  each process its own budget (effectively multiplying the caps by the
  process count). That's a documented limitation, not an oversight — real
  multi-process scale would warrant a shared store, which is exactly the
  kind of infra this prototype deliberately avoids.
