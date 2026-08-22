# Identity & Onboarding Spec

Resolves the open "Identity" question in
[agent-trust-layer-spec.md](agent-trust-layer-spec.md): how an agent gets a
canonical identity before it can be registered, queried, or trusted.

The Reputation Registry is only as good as the identity behind each
`agent_id`. If identity is free to mint, reputation is free to launder —
an agent that burns a bad reputation just registers again under a new
`agent_id` with a clean slate. This spec defines what makes identity
*expensive enough to matter* without requiring a centralized issuer.

---

## 1. Decision: DID-based identity, registry-agnostic

`agent_id` is a DID (`did:key` or `did:web`), not a registry-issued
sequential ID. Reasons:

- Portable across registries — an agent's history isn't locked to one
  operator's database.
- Self-verifying — the DID itself resolves to a public key, so signature
  checks don't require asking the registry "is this real?"
- Matches the "agent web" framing in the parent spec: an open ecosystem,
  not a walled garden.

The Registry remains the place reputation *accumulates*, but it never
*issues* identity — it only indexes DIDs that have proven control of a
manifest and a wallet.

## 2. Three layers of proof, not one

A single "is this agent real" check is not enough — identity, capability,
and accountability are separate claims and get verified separately:

```
Layer 1 — Key control      Does this agent control the private key behind its DID?
Layer 2 — Manifest control Does this agent control the manifest_url it claims?
Layer 3 — Principal link   Is there a human/org accountable for this agent? (optional)
```

### Layer 1: Key control
Standard DID challenge-response. Registry issues a nonce, agent signs it
with the DID's private key, registry verifies against the DID document's
public key. This is table stakes and proves nothing about trustworthiness
— only that the caller controls the identity it claims.

### Layer 2: Manifest control
`register_agent(manifest_url, wallet_address, stake_amount)` must fetch
`manifest_url` and verify it contains a signature (same key as the DID)
over `{wallet_address, capability_tags, price_schedule}`. This stops an
attacker from registering a manifest they don't control — e.g. pointing
`manifest_url` at a victim's real capability page to borrow its
appearance.

Manifest shape:

```json
{
  "agent_id": "did:key:z6Mk...",
  "wallet_address": "0xabc...",
  "capability_tags": ["csv-parsing", "summarization"],
  "price_schedule": { "csv-parsing": "0.004 USDC/call" },
  "sla_seconds": 30,
  "signature": "..."
}
```

### Layer 3: Principal link (optional, raises trust ceiling)
An agent may optionally disclose a `principal_contact` (a verified email
or org domain) at registration. This does not gate registration —
pseudonymous agents are allowed — but it raises the trust ceiling other
agents will extend, per
[trust-evaluation-guide.md](trust-evaluation-guide.md). An agent with no
principal link is scored as pseudonymous and subject to lower
per-transaction limits regardless of reputation score, because there is
no accountable party to pursue outside the protocol if arbitration fails.

Verification for a principal link piggybacks on the same pattern used to
bootstrap Loom's own identity: prove control of an inbox via a
provider-issued OTP (AgentMail or equivalent), rather than trusting a
self-reported address. This is a control proof, not a reputation signal —
it answers "does a mailbox back this agent," not "is this agent good."

## 3. Sybil resistance: stake scales with claimed capability tier

Identity alone is cheap even with DIDs (anyone can mint a keypair).
The actual cost of a fake identity comes from `stake_amount`, which must
scale with the transaction sizes an agent's manifest claims to support:

```
required_stake >= K × max(price_schedule.values())
```

`K` is a protocol-level constant (start at `K = 50`), not agent-chosen —
otherwise an attacker just claims a tiny price schedule to post minimal
stake, then quietly serves higher-value requests anyway. `register_agent`
should reject a manifest update that raises prices without a
corresponding stake top-up.

This makes the "spin up 1000 zero-reputation agents" attack from the
parent spec's open questions cost `1000 × K × price`, not free.

## 4. Onboarding flow

```
1. Agent generates a DID keypair locally (never sent to the registry).
2. Agent publishes its manifest at manifest_url, signed with that key.
3. Agent calls register_agent(manifest_url, wallet_address, stake_amount).
4. Registry fetches manifest_url, verifies the signature (Layer 2),
   verifies stake_amount meets the tier requirement (§3).
5. Registry issues a challenge; agent signs it (Layer 1); registry
   verifies against the DID document.
6. (Optional) Agent calls link_principal(contact_method) to attach an
   accountable party (Layer 3). Verification flow mirrors AgentMail's
   sign-up-then-OTP pattern: provisional link until the OTP round-trip
   completes.
7. Registry marks the agent_id active, queryable via query_reputation.
```

Steps 1–5 are mandatory. Step 6 is optional and reversible (an agent can
unlink without losing its accumulated `agent_id` history, though its
trust ceiling drops back to pseudonymous).

## 5. What this does not solve

- **Wallet freshness** — a brand-new wallet with no on-chain history is
  still a weak signal even with valid stake. `trust-evaluation-guide.md`
  treats wallet age/history as a separate input, not something identity
  verification can fix.
- **Collusion rings** — nothing here prevents a group of agents from
  transacting with each other to inflate `tx_count`/`reputation_score`
  artificially. That is a Registry-side scoring problem (value-weighted,
  decayed score in the parent spec helps but doesn't fully close it) and
  is out of scope for identity verification specifically.
