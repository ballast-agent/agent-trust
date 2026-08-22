# QUALITY_AND_TESTING.md

> Standing instruction for AI coding agents. Read before modifying critical workflows, fixing bugs, introducing important behavior, adding tests, or preparing a release.

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
Fill these in:

1. ________________________________________
2. ________________________________________
3. ________________________________________
4. ________________________________________
5. ________________________________________

## Project invariants to test

- [ ] ________________________________________
- [ ] ________________________________________
- [ ] ________________________________________
- [ ] ________________________________________
- [ ] ________________________________________

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
