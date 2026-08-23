# DATA_AND_STATE.md

> Standing instruction for AI coding agents. Read before adding database fields, stores, caches, local-storage values, URL state, migrations, history systems, or cross-screen data.

## Core principle
The common state failure in AI-built apps is not insufficient state management. It is **too many representations of the same state**.

```text
component state
global store
localStorage
database
URL
query cache
```

can easily become six competing truths.

Every important piece of data should have a canonical owner.

## Classify state before storing it

### Persistent domain state
Examples: project name, saved document, workflow definition, subscription.

Usually belongs in durable storage.

### Server-derived state
Examples: search results, usage total, account balance, aggregates.

Usually fetched/cached rather than independently recreated client-side.

### URL/navigation state
Examples: selected tab, page, shareable filters, search query.

May belong in the URL.

### Ephemeral UI state
Examples: modal open, hovered row, temporary selection.

Usually belongs locally in UI/component state.

### Derived state
Examples:

```text
fullName = firstName + lastName
isOverLimit = usage > quota
filteredItems = filter(items)
```

Prefer computing it rather than storing an independent copy.

## One source of truth
For each major concept define:

```text
canonical source
↓
derived representations
↓
UI
```

Never create a second authoritative source merely because another screen needs the same data.

## Avoid mirroring without need
Avoid copying:

```text
props → local state
server response → separate global state
database object → permanent form copy
```

unless there is a deliberate draft/editing reason.

Mirrors drift.

## Domain model first
The data model should represent the product's domain, not today's screen layout.

Ask:

- What entity is this?
- What identity does it have?
- What relationships does it have?
- What lifecycle does it have?
- Which values are intrinsic?
- Which are derived?

## Avoid JSON-blob escape hatches
JSON fields can be useful, but do not use them to avoid modeling important domain concepts.

Prefer structured fields/entities when data:

- drives permissions;
- is frequently queried;
- has important validation;
- participates in relationships;
- evolves independently;
- requires indexing.

## Stable identity
Use stable identifiers. Do not use mutable display names, array indexes, filenames, or changeable slugs as authoritative identity when collisions/changes are possible.

Separate identity from presentation.

## Derived-state rule
Before storing a value ask:

> Can this be reliably calculated from canonical data?

If yes, prefer derivation unless historical snapshots, performance, or other concrete needs justify materialization.

If derived data is stored, define how it remains synchronized.

## Cache is not source of truth
Define for each cache:

- cache key;
- canonical owner;
- invalidation;
- TTL if relevant;
- stale behavior;
- refresh behavior.

"Clear everything and hope" is not an invalidation strategy.

## Local-storage discipline
Do not use local storage as an accidental second database.

Be cautious storing:

- secrets;
- sensitive content;
- authoritative entitlement;
- critical business state.

Long-lived stored structures need versioning/migration strategy.

## URL state
Use URLs for state that benefits from bookmarking, sharing, refresh persistence, or browser navigation.

Avoid putting sensitive information in URLs unnecessarily because URLs can enter history, logs, and referrers.

## Form state
Distinguish:

```text
saved entity
```

from:

```text
unsaved draft
```

On save, validate, handle conflicts, preserve recoverable drafts, and communicate failure clearly.

## Data ownership table
For complex projects, maintain something like:

| Data | Canonical owner | Persistence | Derived consumers |
|---|---|---|---|
| User profile | Server/database | DB | Header, settings |
| Current filter | URL | URL | List view |
| Modal visibility | Component | None | Modal |
| Usage total | Server | DB/aggregate | Billing UI |

## State transitions
Important entities should have explicit valid transitions.

```text
draft → processing → complete
                 ↘ failed
```

Do not allow arbitrary status assignment from untrusted clients.

Centralize transition rules.

## Optimistic UI
Optimistic updates must define:

- canonical server result;
- rollback;
- conflict handling;
- duplicate submission behavior;
- reconciliation after reconnect.

Do not leave UI state claiming success after server rejection.

## Race conditions
Consider:

- two tabs;
- two devices;
- autosave + manual save;
- background refresh + active edits;
- two users editing shared data;
- duplicate requests.

For conflict-sensitive data consider version numbers, timestamps, compare-and-swap, transactions, or server conflict detection.

## Transactions
Use transactions when a business action requires multiple writes to succeed or fail together.

If partial completion creates invalid state, atomicity matters.

## Data constraints
Critical invariants should not exist only in UI validation.

Use appropriate database protections such as:

- unique constraints;
- foreign keys;
- non-null constraints;
- checks;
- transactional guarantees.

Application validation improves messages. Data constraints protect integrity.

## Migrations
Production data is not disposable.

For schema changes:

1. inspect existing values;
2. avoid destructive assumptions;
3. add new fields safely;
4. backfill;
5. switch reads/writes;
6. enforce stronger constraints later;
7. remove legacy paths after verification.

## Backward compatibility
During deployment, old and new app versions may briefly coexist. Prefer additive transitions before destructive cleanup where relevant.

## Deletion semantics
Define what delete means:

- soft delete;
- hard delete;
- archive;
- unlink;
- revoke access.

Consider dependent records and ownership/shared-resource consequences.

## History/audit data
Do not create separate history systems for every feature.

Define:

- which events are recorded;
- who performed them;
- timestamp;
- resource;
- retention;
- visibility;
- whether history is user-facing or operational.

Avoid storing full sensitive payloads without need.

## Naming consistency
Use one canonical field name per concept within an architectural layer.

Avoid families like:

```text
created
createdAt
created_at
dateCreated
```

unless an external boundary requires mapping. Normalize at boundaries.

## Data-model audit
Periodically search for:

- duplicate fields;
- duplicate entities;
- nullable-everything schemas;
- core business data buried in JSON blobs;
- undocumented status strings;
- inconsistent identifiers;
- stale denormalized fields;
- fields no longer used.

## State audit
For every major feature ask:

1. Where does canonical state live?
2. Who may mutate it?
3. What is derived?
4. What is cached?
5. What persists across refresh?
6. How is cache/state invalidated?
7. What happens with simultaneous updates?
8. What happens on failure?
9. What happens after reconnect?
10. Is the same concept stored elsewhere?

## Project data invariants
Examples:

```text
Every file belongs to exactly one workspace.
A completed run never changes its recorded input snapshot.
Usage totals cannot become negative.
A deleted parent cannot leave active invalid children.
```

AgentTrust's invariants:

- [x] `reputation_score` is never stored — it's computed on read by `scoring.ts`'s value-weighted, time-decayed formula from settled reviews, so it can never drift out of sync with the underlying data (see `registry-server/README.md`'s design note).
- [x] A `Review` can only be inserted against a `Transaction` whose status is in `SETTLED_STATUSES` (`released`/`refunded`/`slashed`) — enforced in `submitReview`, not just documented. No transaction, no review; no unsettled transaction, no review either.
- [x] The `transactions` table has exactly one owner (`registry-server/src/db.ts`); `escrow-server` mutates it through that same module's functions, never through a second connection with its own schema assumptions.
- [x] `stake_amount` only changes through `reduceStake` (called by `slash_stake`, itself only reachable via a verified arbitration-capable signature) — never decremented anywhere else.
- [x] Every `transactions.status` transition is a single atomic `UPDATE ... WHERE status = ?` (`db.ts`'s `setTransactionStatus`/`setDeliverableHash`), never a separate read-then-write — a losing concurrent call gets `changes: 0` and must be rejected, not silently reapplied on top of a status it never actually observed.
- [x] Every field `get_manifest` returns on a cache hit is a real value persisted from the agent's last verified manifest fetch (`agents.sla_seconds`/`manifest_signature`) — never a placeholder standing in for "we didn't store this." A pre-migration row reads back `null` and is treated as cache-miss-worthy rather than served as if `0`/`""` were the truth (issue #14).

## Standing instruction before adding state
Before creating a store, field, cache, or persistence layer:

1. search for an existing representation;
2. classify the state;
3. identify canonical owner;
4. determine persistence/lifecycle;
5. define synchronization/failure behavior;
6. ask whether it can be derived;
7. avoid new global state unless genuinely shared/global.

The default question is not:

> "Where can I put this state?"

It is:

> **"Should this state exist independently at all?"**
