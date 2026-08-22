# AI_PROJECT_GUARDRAILS.md

> **Read this first.**
>
> This project uses AI coding tools. The files below are standing product and engineering requirements intended to prevent common vibe-coding failure modes.

## Guardrail files

### `PRODUCT_COHESION.md`
Use when adding user-facing features, changing navigation, creating pages, introducing product concepts, or redesigning workflows.

Protects against feature soup, disjointed UX, duplicate concepts, navigation sprawl, and inconsistent interactions.

### `ARCHITECTURE_GUARDRAILS.md`
Use when adding services/modules/stores, refactoring, adding dependencies, changing APIs, or introducing architectural patterns.

Protects against architecture drift, parallel systems, over-abstraction, dependency sprawl, and duplicated business logic.

### `SECURITY_GUARDRAILS.md`
Use when handling authentication, permissions, uploads, payments, admin features, user-owned/sensitive data, APIs, or integrations.

Protects against frontend-only security, broken authorization, secret exposure, injection, abuse, unsafe uploads, and insecure webhooks.

### `DATA_AND_STATE.md`
Use when adding stores, database fields, caches, persistence, migrations, URL state, local storage, or cross-screen state.

Protects against multiple sources of truth, state duplication, data-model debt, unsafe migrations, race conditions, and stale caches.

### `QUALITY_AND_TESTING.md`
Use when adding tests, changing critical behavior, fixing bugs, refactoring important flows, or preparing a release.

Protects against happy-path-only software, meaningless test volume, regression blindness, permission regressions, and untested edge cases.

### `AI_CODING_HYGIENE.md`
Use continuously during AI-assisted development.

Protects against generation without inspection, dead-code accumulation, unnecessary packages, naming drift, giant rewrites, agent inconsistency, and endless additive development.

## Default instruction to any AI coding agent
Before implementing a non-trivial request:

1. Read this file.
2. Read every guardrail relevant to the requested change.
3. Inspect the existing implementation before creating new systems.
4. Prefer reuse and consolidation over duplication.
5. Identify security, state, migration, and regression implications.
6. Implement the smallest coherent change.
7. Remove obsolete code created by the change when safe.
8. Verify important happy and unhappy paths.

## Required mental model
AI is strong at:

```text
"Make this feature work."
```

These guardrails force consideration of:

```text
Should it exist?
Where does it belong?
What should it reuse?
What is the source of truth?
What must never break?
Who is allowed to do it?
What happens when it fails?
How will it behave at scale?
What old complexity can now be removed?
```

## Recommended development cycle
Do not endlessly add features.

Use:

```text
BUILD
  ↓
VERIFY
  ↓
AUDIT
  ↓
CONSOLIDATE
  ↓
DELETE
  ↓
SIMPLIFY
  ↓
BUILD
```

## Suggested periodic audits
After a significant batch of work, ask the AI to perform:

1. Product cohesion audit
2. Architecture duplication audit
3. State/data ownership audit
4. Security audit
5. Critical workflow/regression audit
6. Dead-code/dependency cleanup audit

Do not prioritize cosmetic changes while foundational issues remain unresolved.

## Project-specific invariants
Add rules that must never be violated.

Examples:

```text
A user cannot access another user's private data without explicit permission.
Billing entitlement is always server-authoritative.
There is one canonical representation of the primary product object.
Exports are generated from canonical current state.
Destructive schema changes require a migration plan.
```

Project invariants:

The full trust-layer design lives in
[project-docs/agent-trust-layer-spec.md](../project-docs/agent-trust-layer-spec.md),
[project-docs/identity-and-onboarding-spec.md](../project-docs/identity-and-onboarding-spec.md),
and [project-docs/trust-evaluation-guide.md](../project-docs/trust-evaluation-guide.md).
Summarized:

- [ ] A `reputation_score` can only be affected by a `Review` attached to a real, settled `Transaction` — no reviews without money having moved through escrow.
- [ ] `agent_id` is a DID the agent controls; the Registry indexes identities, it never issues them.
- [ ] `register_agent` never accepts a manifest the caller doesn't control — signature over the manifest is verified against the DID before registration succeeds.
- [ ] `stake_amount` is enforced server-side against the agent's own claimed price schedule (`required_stake >= K × max_price`); an agent cannot register with unstaked pricing.
- [ ] `submit_review` is only callable by the payer or payee of the specific settled `tx_id` it references, never by a third party.
- [ ] `slash_stake` is only callable by the Escrow Layer or an authorized Arbitration Agent on a confirmed dispute finding — never by either transacting party unilaterally.
- [ ] Escrowed funds are never released on the buyer's unverified say-so alone in a High-value transaction — arbitration is pre-selected at escrow creation, not chosen after a dispute arises.

## Final principle
These files are not intended to slow development down.

They exist so that high implementation speed does not become:

```text
high feature count
+ high complexity
+ hidden fragility
```

The desired outcome is:

> **AI development speed with the discipline of a mature product and engineering team.**
