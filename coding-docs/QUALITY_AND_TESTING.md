# QUALITY_AND_TESTING.md

> Standing instruction for AI coding agents. Read before modifying critical workflows, fixing bugs, introducing important behavior, adding tests, or preparing a release.

**AgentTrust has no UI.** Everything here about screens, mobile viewports,
accessibility, and responsive/RTL text does not apply — this is a pair of
headless MCP servers plus a demo script. Translate as you read: "critical
user journeys" means the tool-call sequences in `demo/src/e2e-demo.ts`
(register → create_escrow → submit_deliverable → confirm_release →
query_reputation), "UI states" means a tool call's success/error result
shape, and "authorization tests" means signature-verification tests
(exactly what `registry-server/test/registry.test.ts` and
`escrow-server/test/escrow.test.ts` already do — read one before adding a
test elsewhere in this project). The underlying principle — protect
critical flows and invariants, not implementation details — still fully
applies.

## Core principle
AI can generate huge quantities of tests that prove very little.

Do not optimize for:

- test count;
- coverage percentage alone;
- snapshot volume;
- implementation-detail assertions.

Optimize for:

> **confidence that important user behavior and product invariants remain correct under realistic conditions**

## Test the product, not the implementation
Prefer:

```text
user can upload → transform → export
```

over:

```text
component calls helper X exactly once
```

Implementation changes. Expected behavior should remain.

## Use the cheapest reliable test layer

### Unit tests
Best for pure business rules, transformations, parsers, validators, calculations, and state transitions.

### Integration tests
Best for service/database behavior, APIs, permissions, persistence, and provider adapters.

### End-to-end tests
Best for critical user journeys, authentication, checkout, destructive flows, and cross-screen behavior.

Do not make everything E2E. Do not rely only on unit tests either.

## Critical journeys first
Identify the app's most important flows, for example:

```text
sign up → create first item → save
import → edit → export
subscribe → entitlement active
create → share → collaborator opens
```

Protect these before obscure visual details.

## Product invariants
Tests should protect things that must always remain true.

Examples:

```text
user A cannot access user B's private project
failed payment never grants paid access
deleting a parent never leaves active invalid children
export reflects canonical current state
quota cannot be bypassed by calling the API directly
```

Invariant tests often provide more value than dozens of superficial tests.

## Happy path is not enough
For meaningful operations consider:

- success;
- validation failure;
- server failure;
- network failure where relevant;
- retry;
- duplicate submission;
- empty input;
- boundary values;
- malformed external response;
- stale state;
- permission failure.

## Edge-case checklist
Consider as relevant:

- zero;
- one;
- very many;
- empty string;
- extremely long string;
- Unicode/emoji;
- RTL text where relevant;
- duplicate names;
- missing fields;
- invalid dates;
- leap years;
- daylight-saving transitions;
- timezones;
- huge files;
- slow responses;
- refresh mid-operation;
- browser back/forward;
- mobile viewport.

## Regression tests for bugs
When fixing a bug:

1. reproduce it;
2. identify root cause;
3. add a failing regression test where practical;
4. fix it;
5. verify adjacent behavior.

Do not patch only the visible symptom.

## Authorization tests
Sensitive/user-owned endpoints should test:

- allowed owner;
- unauthorized user;
- unauthenticated user;
- elevated role if relevant;
- nonexistent/malformed resource.

Do not assume UI tests cover authorization.

## Data-integrity tests
Protect critical uniqueness, relationships, state transitions, transaction rollback, deletion behavior, and migration assumptions.

If invalid data would be expensive or dangerous, protect it with both implementation constraints and tests.

## Contract tests
For APIs and external providers, protect important request/response shapes, normalization, error mapping, and unsupported values.

Mock external providers at stable boundaries. Do not mock so deeply that tests prove only the mocks.

## Avoid brittle tests
Red flags:

- markup-order dependence;
- excessive snapshots;
- fragile CSS selectors;
- private implementation assertions;
- fixed sleeps;
- live network dependencies in ordinary suites.

Prefer semantic selectors, stable contracts, and deterministic timing.

## Time and randomness
Control nondeterminism. Freeze/inject clocks, random generators, UUID sources, and external responses when needed.

Flaky tests train maintainers to ignore failures.

### Testing the concurrency guards (node:sqlite specifics)

`node:sqlite`'s `DatabaseSync` is fully synchronous: within one JS thread
there is no execution interleaving at all. That has two consequences for
this repo's atomic state-transition guards (`registry-server/src/db.ts`'s
`setTransactionStatus` / `setDeliverableHash`):

1. Sequential in-process calls ("call A, then call B, assert B returned
   false") exercise the real SQL-level CAS precondition — the guarded
   `UPDATE ... WHERE status IN (...)` matches 0 rows on a stale read — and
   are the cheapest reliable layer for that property.
2. They cannot by themselves prove anything about genuine simultaneous
   execution, because there is none in-process.

What node:sqlite DOES support is multiple independent connections to the
same database file from different threads (`worker_threads`), which gives
real OS-level contention serialized by SQLite's own file locking.
Empirical model (node v24, default rollback-journal mode `"delete"`):

- `:memory:` databases are per-connection and cannot be shared across
  connections or threads — concurrency tests must use a temp file.
- Concurrent writers block each other rather than corrupting, provided
  every connection arms `PRAGMA busy_timeout`; without it a blocked writer
  surfaces SQLITE_BUSY immediately.
- tsx's TS module loader propagates into workers, so workers can import
  the REAL transition functions instead of testing a copied SQL string.

The genuine-concurrency stress tests live at the bottom of
`escrow-server/test/escrow.test.ts`: N workers × M iterations hammering
one row via guarded transitions (asserting no BUSY errors, sane terminal
state, intact deliverable hash), plus a first-writer-wins race on
`setDeliverableHash`. Cleanup of temp dirs is best-effort because worker
connections can release file handles slightly after posting results
(Windows EPERM otherwise).

## Performance quality
For performance-sensitive features test representative input sizes. Do not infer scalability from toy development data.

Define practical budgets where useful:

- initial load;
- interaction response;
- memory;
- large-dataset processing;
- API latency/query count.

## Accessibility quality
Check important UI for:

- keyboard navigation;
- focus order;
- visible focus;
- labels/semantics;
- dialog focus behavior;
- screen-reader names;
- contrast where applicable.

Automated scans help but are not sufficient alone.

## Responsive quality
Mobile QA is not just "does it fit?"

Check touch targets, overflow, keyboards, tables, drawers/modals, dense controls, and orientation where relevant.

## Error-state quality
Explicitly exercise:

- loading;
- empty;
- partial;
- failed;
- unauthorized;
- stale;
- retrying;
- offline if supported.

These states are part of the product.

## Test fixtures
Use small, understandable, realistic fixtures. Include normal, boundary, and malformed examples where useful.

Avoid giant mystery fixtures copied from production.

## Test naming
Name tests after behavior.

Good:

```text
denies export when user no longer owns the project
```

Bad:

```text
testExport2
```

The suite should read like product rules.

## Definition of done
A meaningful feature is not complete merely because it renders and the happy path works locally.

Completion should consider:

- failure states;
- permissions;
- data integrity;
- regression risk;
- appropriate tests;
- obsolete-code cleanup;
- accessibility/responsiveness where relevant.

## Before risky refactors

1. identify behaviors that must not change;
2. verify/add tests around them;
3. refactor;
4. run relevant suites;
5. manually exercise the core journey.

## QA audit
Periodically inspect:

### Critical flows
Are the most important journeys protected end-to-end?

### Business rules
Are critical calculations/transitions protected?

### Permissions
Are forbidden cases tested?

### Edge cases
Are realistic boundary cases represented?

### Test quality
Are tests behavior-focused or implementation-bound?

### Flakiness
Are unreliable tests being ignored?

### Dead tests
Are tests preserving behavior that no longer exists?

## Project critical journeys

1. `register_agent` with a correctly signed manifest and sufficient stake succeeds; with a tampered manifest, mismatched wallet, or insufficient stake, it fails — see `registry-server/test/registry.test.ts`.
2. `create_escrow` → `submit_deliverable` → `confirm_release` releases funds and writes a satisfied review in one pass — see `escrow-server/test/escrow.test.ts`'s "full happy path" test and `demo/src/e2e-demo.ts` end to end.
3. `raise_dispute` → `resolve_dispute(slash)` correctly delegates to and reduces stake via the Registry's own `slash_stake`, and rejects an arbiter that wasn't pre-selected at escrow creation.
4. `reclaimExpired` refuses before the SLA deadline and succeeds after it.
5. `query_reputation`'s decayed, value-weighted score reflects real settled reviews, not a stale cached value (there is no cache to go stale — see `DATA_AND_STATE.md`'s AgentTrust invariant on this).

## Project invariants to test

- [x] No review can attach to a non-settled transaction (`submit_review rejects reviews against a non-settled transaction`).
- [x] A forged signature (real party's payload, wrong party's key) is rejected everywhere a signature is required, not just on the "happy" signer.
- [x] `slash_stake`/`resolve_dispute(slash)` only succeeds for a registered agent with the `arbitration` capability tag, pre-selected at escrow creation.
- [x] Stake gating (`required_stake >= K × max_price`) is enforced server-side at registration, not merely documented.
- [x] Concurrent/duplicate calls to the same tool with the same `tx_id` — fixed at the SQL level: every status transition in `db.ts` is an atomic `UPDATE ... WHERE status = ?`, not a read-then-write, so a losing concurrent call gets `changes: 0` and is rejected rather than silently double-applying. Proven both directly (`db.setTransactionStatus`/`setDeliverableHash` called twice in a row) and through the tool layer (`confirm_release`, `submit_deliverable`, `raise_dispute` vs `confirm_release`, `resolveDispute(slash)`) in `escrow-server/test/escrow.test.ts`.

## Standing instruction to AI agents
When adding tests:

- test behavior that matters;
- use the lowest appropriate layer;
- protect invariants;
- cover important failure paths;
- avoid brittle implementation-detail tests;
- add regression tests for real bugs;
- do not inflate test count for appearance.

The goal is:

> **A trustworthy test suite that catches expensive mistakes before users do.**
