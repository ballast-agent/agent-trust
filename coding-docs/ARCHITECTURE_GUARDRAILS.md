# ARCHITECTURE_GUARDRAILS.md

> Standing instruction for AI coding agents. Read this before introducing new services, stores, modules, dependencies, APIs, major refactors, or features that touch several parts of the application.

## Core principle
AI agents are excellent at local problem-solving and therefore prone to **global architectural drift**.

Before adding a new architectural concept, inspect what already exists. Prefer:

```text
reuse → extend → simplify → consolidate
```

over:

```text
duplicate → wrap → fork → invent → layer
```

A feature is not complete if it works only by creating a second way to do something the app already knows how to do.

## Architecture serves the product
Architecture exists to make the product easier to understand, change, test, secure, and remove. Do not add patterns because they are fashionable. Do not build generic infrastructure for hypothetical future needs. Prefer boring, explicit structures over clever abstractions.

## Inspect before creating
Before adding a non-trivial feature, inspect:

- routes;
- domain models;
- stores/state;
- services;
- API clients;
- persistence;
- shared components;
- utilities;
- configuration;
- build/deploy boundaries.

Do not assume the right solution is a new file, provider, hook, service, store, registry, or abstraction.

## Keep responsibilities clear
A useful mental model is:

```text
UI
 ↓
Application/use-cases
 ↓
Domain logic
 ↓
Infrastructure/APIs/persistence
```

Rules:

- UI must not own critical business rules.
- Business rules should not depend on presentation details.
- External-provider details should not leak throughout the app.
- Persistence should have clear ownership.
- Shared domain concepts should have canonical representations.

## Avoid parallel systems
Before creating any new service, store, cache, repository, API wrapper, validation system, persistence mechanism, history system, event bus, background queue, or configuration layer, search for an existing system with overlapping responsibility.

Red flag:

```text
exportService
batchExportService
downloadService
fileExportHelper
```

when one coherent export subsystem would suffice.

If two systems model the same responsibility, consolidate instead of extending both.

## Favor boring architecture
Prefer:

```text
function
module
service
component
plain object
small interface
```

before reaching for:

```text
factory
registry
plugin system
dynamic dependency injection
event bus
generic orchestration layer
meta-framework
```

Do not build infrastructure for imaginary future use cases.

## Abstraction rule
Abstract when:

1. the same real concept appears in multiple places;
2. behavior must remain consistent;
3. the abstraction has a clear domain name;
4. it reduces cognitive load.

Avoid both copy/paste sprawl and premature mega-abstractions.

> Prefer temporary duplication over the wrong abstraction, then refactor once the pattern is real.

## Dependency discipline
Before adding a dependency ask:

1. Can the framework/platform do this already?
2. Can an existing dependency do it?
3. Is the package maintained and mature?
4. Does it justify its size and complexity?
5. Does it introduce build/runtime constraints?
6. Can we remove it easily later?

Do not install a package to avoid writing a small amount of straightforward code.

## Centralize business rules
Critical rules should have authoritative implementations, including pricing, permissions, entitlements, quotas, state transitions, validation, scheduling, billing state, ownership, and eligibility.

Avoid families like:

```text
calculatePrice()
calculateCheckoutPrice()
calculateInvoiceTotal()
calculateSubscriptionPrice()
```

when they duplicate rules.

## Stable boundaries and contracts
At boundaries such as UI ↔ application, application ↔ API, API ↔ database, and application ↔ external service, use clear contracts.

Normalize external shapes rather than letting every caller interpret raw responses differently. Avoid several names for the same concept unless the distinctions are real.

## Avoid hidden coupling
Red flags:

- module imports mutate global state;
- component A relies on side effects from component B;
- a function silently updates unrelated caches;
- behavior depends on undocumented initialization order;
- feature behavior relies on hidden globals.

Prefer explicit inputs, outputs, dependencies, and effects.

## Keep side effects at the edges
Where practical, make transformations and business rules deterministic:

```text
input → function → output
```

Keep database writes, network requests, file writes, analytics, notifications, and local storage at clear boundaries.

## Concurrency and idempotency
For any mutation ask:

> What happens if this request happens twice?

Consider double-clicks, retries, two tabs, two devices, stale writes, concurrent updates, and partial completion. Use transactions, idempotency keys, deduplication, or conflict detection where appropriate.

## Production is not development
Do not design around assumptions of one user, tiny datasets, zero latency, perfect networks/APIs, unlimited memory, no concurrent writes, or disposable data.

## Migration-friendly design
Prefer:

```text
add new field
→ support old + new
→ backfill
→ switch reads
→ switch writes
→ remove old field
```

over destructive one-step changes.

## Dead code is architecture debt
When replacing an approach, remove obsolete routes, components, utilities, flags, config, persistence paths, and wrappers. Version control is the archive.

## Naming and structure
Prefer responsibility-based names such as `billing/`, `permissions/`, `exports/`, and `datasets/` over dumping grounds such as `helpers/`, `misc/`, `common2/`, or `utils_new/`.

If a file cannot be described in one sentence, it may have too many responsibilities.

## Architectural invariants
Document project-specific facts that must remain true.

Examples:

```text
All entitlement checks are server-authoritative.
All exports use the canonical transformed-data model.
No UI component calls the billing provider directly.
```

Add yours:

- [ ] ________________________________________
- [ ] ________________________________________
- [ ] ________________________________________

## Decision test for new architecture
Before introducing a new mechanism, answer:

**Problem:** What concrete problem exists now?

**Existing mechanism:** Why can the current architecture not solve it cleanly?

**Proposal:** What are we introducing?

**Scope:** Where is it allowed?

**Tradeoff:** What complexity does it add?

**Exit strategy:** How difficult will it be to remove?

If the problem cannot be stated clearly, do not add the mechanism.

## Architecture audit
Periodically inspect for:

### Duplication
- overlapping services;
- duplicate stores/models/API clients;
- repeated transformation/business logic.

### Layer violations
- business rules inside UI;
- arbitrary direct database access;
- provider-specific code spread throughout the app.

### Dependency sprawl
- unused packages;
- overlapping libraries;
- trivial packages;
- abandoned dependencies.

### Complexity creep
- factories used once;
- generic systems with one consumer;
- circular dependencies;
- excessive provider/context nesting.

### Dead systems
- obsolete routes;
- stale components;
- legacy persistence;
- abandoned feature flags.

## Refactor order
When architecture is fragmented, prefer:

1. canonical domain model;
2. centralized business rules;
3. clear state/data ownership;
4. consolidated services;
5. normalized boundaries/APIs;
6. simplified UI integration;
7. dead-code removal;
8. folder/naming cleanup.

Do not begin with cosmetic folder shuffling.

## Standing instruction to AI agents
Before significant implementation:

1. inspect the existing architecture;
2. identify the canonical path for this responsibility;
3. extend existing systems when appropriate;
4. avoid new abstractions unless justified;
5. avoid duplicate business logic;
6. consider failure, retries, and concurrency;
7. remove superseded code when safe;
8. verify the result through real user flows.

The goal is:

> **A codebase future agents can understand quickly and change safely.**
