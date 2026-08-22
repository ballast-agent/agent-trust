# AI_CODING_HYGIENE.md

> Standing instruction for AI coding agents and human operators. This file governs the *process* of AI-assisted development.

## Core principle
AI dramatically reduces the cost of producing code. It does **not** automatically reduce the cost of understanding, maintaining, debugging, securing, coordinating, or deleting that code.

Therefore:

> **Generation speed must be balanced by deliberate inspection, consolidation, and deletion.**

## Inspect before creating
Before adding a component, hook, service, store, utility, route, table, dependency, or pattern, search the codebase for an existing equivalent.

Do not create `Foo2`, `NewFoo`, `FooV2`, or `BetterFoo` unless there is a deliberate migration plan.

## Do not solve prompts in isolation
A feature request is not permission to ignore the rest of the system.

Before implementing, inspect neighboring features, shared models/components, terminology, project guardrails, and existing patterns.

Ask:

> **How does this change the existing system?**

not merely:

> **How can I satisfy this prompt?**

## Read project guardrails
Before substantial work, consult applicable files:

```text
PRODUCT_COHESION.md
ARCHITECTURE_GUARDRAILS.md
SECURITY_GUARDRAILS.md
DATA_AND_STATE.md
QUALITY_AND_TESTING.md
DESIGN_SYSTEM.md (if present)
```

These are requirements, not optional inspiration.

## Smallest coherent change
Prefer the smallest change that solves the actual user problem **without creating future fragmentation**.

This does not always mean fewest lines. Sometimes a small refactor is safer than a one-line hack.

Avoid unrelated rewrites.

## Temporary hacks must be explicit
If a workaround is genuinely necessary:

- explain why;
- isolate it;
- add a specific TODO with removal condition;
- avoid spreading it across the system.

Do not normalize temporary code by repeatedly building on top of it.

## Delete superseded code
When replacing an approach, remove the old approach when safe.

AI-heavy projects commonly accumulate:

```text
old implementation
new implementation
fallback implementation
temporary implementation
unused implementation
```

Version control is the archive.

## No dependency for every problem
Before installing a package:

1. search current dependencies;
2. check framework/platform capability;
3. estimate direct implementation complexity;
4. assess maintenance/security cost.

A dependency is permanent surface area until removed.

## Prevent naming drift
Reuse existing project language.

Before inventing a new entity, status, feature label, folder concept, or action name, search for related terminology.

Do not create synonyms casually.

## Comments explain why
Do not narrate obvious syntax.

Useful comments explain:

- non-obvious business reason;
- provider quirk;
- security constraint;
- algorithmic tradeoff;
- migration compatibility;
- deliberate exception.

Bad:

```text
// increment i
```

Good:

```text
// Provider may deliver the same event more than once;
// event ID is persisted to keep processing idempotent.
```

## Do not hide uncertainty
If uncertain about framework behavior, data ownership, permissions, migration safety, or external APIs, inspect relevant code/docs rather than inventing assumptions.

If an assumption remains necessary, make it visible.

## Avoid giant-diff syndrome
Large AI rewrites are difficult to review and easy to get subtly wrong.

Prefer staged changes:

```text
establish shared model
→ migrate one caller
→ migrate remaining callers
→ remove old implementation
```

rather than rewriting half the app at once.

## Protect behavior during refactors
Before broad refactoring:

- identify critical workflows;
- identify invariants;
- verify/add tests;
- preserve external behavior unless intentionally changing it.

Cleaner code is not worth silent regressions.

## Do not polish before the model is right
Avoid prioritizing animation, microcopy, decorative dashboards, or tiny styling refinements while architecture, data ownership, workflow, or permissions remain confused.

Prefer this order:

```text
product model
→ architecture
→ data/state
→ workflow
→ behavior
→ reliability
→ visual polish
```

## Periodic consolidation passes
After a feature batch, stop adding features.

Search for:

- duplicate components;
- duplicate utilities;
- duplicate state;
- duplicate services;
- inconsistent names;
- dead routes;
- unused dependencies;
- abandoned CSS;
- obsolete flags;
- repeated business rules.

Then simplify.

This is mandatory maintenance in AI-heavy development.

## Feature-surface audit
For each feature, note whether it introduced:

- a route;
- menu item;
- API;
- state domain;
- database entity;
- dependency;
- settings section;
- permission;
- user-facing concept.

If a small feature introduces several permanent surfaces, reconsider the design.

## Reuse order
Prefer this order:

1. reuse existing project capability;
2. use framework/platform capability;
3. build a simple local solution;
4. add a dependency/service when justified.

Do not default immediately to option 4.

## Avoid agent-specific style drift
The codebase should not reveal which AI agent wrote which file.

Follow project conventions for formatting, naming, errors, logging, components, hooks, state, API access, comments, and tests.

If conventions are missing, establish them deliberately.

## Error handling is implementation
Do not ship production error handling that is effectively:

```text
try { ... } catch { console.log(...) }
```

For meaningful operations define user-visible response, retry behavior, logging, cleanup, rollback, and partial-success behavior.

## Avoid silent failure
Do not swallow errors just to keep the UI moving.

Optional functionality may degrade gracefully. Correctness-critical operations must surface failure appropriately.

## Keep warnings clean
Do not routinely ignore unused variables, unreachable code, missing dependencies, deprecated APIs, type errors, or migration warnings.

A permanently noisy build hides new problems.

## Types/schemas are knowledge
Where the project uses types or schemas, keep them meaningful.

Do not weaken types to `any`, `unknown as Foo`, or generic maps just to silence errors.

If the model is unclear, fix the model.

## Generated code must still be owned
Before accepting generated code, ensure:

- purpose is understandable;
- dependencies are known;
- failure behavior is known;
- data flow is clear;
- verification exists where needed.

Code nobody can explain is a liability.

## Avoid premature generalization
Do not build plugin systems, rule engines, workflow DSLs, registries, or meta-frameworks until multiple concrete use cases justify them.

Future flexibility has a maintenance cost today.

## Avoid premature feature completeness
When adding a feature, do not automatically append:

```text
history
templates
sharing
export
analytics
AI assistant
automation
admin settings
```

Build the smallest valuable loop first.

## Change hygiene
When practical, group changes by intent.

Avoid mixing feature implementation, unrelated refactors, whole-repo formatting, dependency upgrades, and schema migrations into one inseparable change.

## AI-generated TODOs
TODOs must be specific.

Bad:

```text
TODO improve
```

Good:

```text
TODO: remove legacy workspaceId fallback after all production rows
are backfilled and null values are no longer accepted.
```

## Recommended development loop
Use:

```text
UNDERSTAND
   ↓
INSPECT
   ↓
DESIGN
   ↓
IMPLEMENT
   ↓
VERIFY
   ↓
CONSOLIDATE
   ↓
DELETE
```

Do not endlessly use:

```text
PROMPT → GENERATE → PROMPT → GENERATE
```

## Vibe-coding health audit
Periodically answer:

### Project comprehension
Can an agent identify the main architecture quickly?

### Duplication
Are multiple systems solving the same problem?

### Surface area
Has route/API/schema/dependency count grown faster than product value?

### Dead code
Is superseded generated code still present?

### Invariants
Are must-not-break rules documented?

### Failure handling
Do important operations handle unhappy paths?

### Security
Are client assumptions being trusted?

### Tests
Do critical journeys have protection?

### Naming
Does one concept have one name?

### Cleanup
When was the last deliberate subtraction/refactor pass?

## Standing instruction
Do not maximize output, lines of code, or feature count.

Optimize for:

> **clarity, durability, correctness, reuse, and the smallest coherent change.**
