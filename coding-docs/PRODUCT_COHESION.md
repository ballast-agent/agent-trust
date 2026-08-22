# PRODUCT_COHESION.md

> **Purpose:** Keep this product coherent as it grows.
>
> This file is a standing instruction for AI coding agents, designers, and maintainers. Read it **before adding, redesigning, or substantially modifying any user-facing feature**.
>
> The goal is simple:
>
> **Build one coherent product, not a collection of individually good features.**

---

## 1. Core Principle

AI makes it very easy to add features. That is useful, but it also creates a common failure mode:

- features are implemented independently;
- similar concepts receive different names;
- every new capability gets its own page;
- screens develop different interaction patterns;
- data and state are duplicated;
- navigation grows continuously;
- the user has to understand more concepts than necessary;
- the product begins to feel like several small apps bundled together.

This project must actively resist that pattern.

Before implementing something new, ask:

> **How does this belong to the product that already exists?**

Do not ask only:

> **How do I build this feature well?**

Local feature quality is not enough. The feature must strengthen the whole system.

---

# 2. Product Cohesion Is a Requirement

Treat product cohesion as a first-class engineering requirement alongside:

- correctness;
- performance;
- accessibility;
- security;
- maintainability;
- visual quality.

A technically correct feature can still be rejected if it makes the product harder to understand.

The product should feel:

- predictable;
- intentional;
- unified;
- learnable;
- progressively discoverable;
- simpler than the number of capabilities it contains.

A user should rarely need to ask:

- "Why is this a separate page?"
- "What's the difference between these two things?"
- "Why does this screen work differently?"
- "Where did the thing I just created go?"
- "Why do I have to enter this again?"
- "Why are there three ways to do nearly the same thing?"

---

# 3. Define the Product Before Extending It

Before making significant additions, establish or update the following section.

## Product Definition

### Primary user

<!-- Describe the main user in one or two sentences. -->

### Primary job

<!-- What is the main thing the user comes here to accomplish? -->

### Primary object

<!--
What is the main thing the user works with?
Examples: Dataset, Document, Project, Dream, Invoice, Campaign, Note.
-->

### Supporting objects

<!--
List only concepts that genuinely need to exist in the user's mental model.
-->

| Object | Purpose | Relationship to primary object |
|---|---|---|
| | | |

### Core workflow

```text
START
  ↓
[Step]
  ↓
[Step]
  ↓
[Step]
  ↓
OUTCOME
```

Every major feature should support this workflow, extend it naturally, or clearly support a secondary workflow.

If a feature does neither, reconsider whether it belongs in the product.

---

# 4. Maintain a Small Product Ontology

An **ontology** is the set of concepts users must understand.

Keep it deliberately small.

Bad:

```text
Project
Workspace
Session
Job
Task
Workflow
Recipe
Template
Preset
Profile
Automation
Run
```

when several of those mean nearly the same thing.

Better:

```text
Project
Workflow
Run
```

with capabilities attached to those objects.

## Rule

Before introducing a new noun into the UI, determine whether an existing product concept can represent it.

Examples:

Instead of introducing:

- `Saved Configuration`
- `Template`
- `Recipe`
- `Profile`
- `Preset`

ask whether these are actually one reusable object.

Do not create synonyms as separate product concepts.

### Concept test

For every proposed new concept, answer:

1. What exactly is it?
2. Why is it different from existing concepts?
3. Can a user explain that difference in one sentence?
4. Does the distinction matter to the user's task?
5. Could it instead be a property, state, action, or view of an existing object?

If questions 2–4 do not have strong answers, **merge the concept into something that already exists**.

---

# 5. Prefer Capabilities Over New Destinations

A new capability does **not** automatically require:

- a new sidebar item;
- a new tab;
- a new dashboard card;
- a new settings page;
- a new standalone screen.

This is one of the most important rules in this document.

## Bad pattern

```text
Dashboard
Files
Cleaner
Validator
Converter
Batch
Templates
Presets
Automation
History
Reports
AI
Settings
```

The product becomes a warehouse of features.

## Better pattern

Capabilities are attached to the objects and workflows where users naturally need them.

Examples:

Instead of a separate **Batch** page:

> Select several items → Apply workflow

Instead of a separate **Templates** page:

> Configure something → Save as template

Instead of a separate **Export Presets** page:

> Export → Save these settings

Instead of a separate **Automation** area:

> Workflow → Schedule

Instead of a separate **History** system:

> Object → Previous runs / activity

## Navigation test

A new permanent navigation destination should exist only if:

- users intentionally visit it as a destination;
- it represents a major product domain;
- it cannot reasonably live within an existing object or workflow;
- it will remain useful as the product evolves.

When possible:

> **Add capability without increasing permanent UI surface area.**

---

# 6. Build Around Workflows, Not Feature Lists

Do not organize development around:

```text
Feature A
Feature B
Feature C
Feature D
```

Organize it around user journeys:

```text
Input
  ↓
Understand
  ↓
Act
  ↓
Review
  ↓
Output
  ↓
Reuse
```

For every new feature, identify:

- where the user encounters it;
- what happens immediately before it;
- what happens immediately after it;
- what object it acts upon;
- what state changes;
- where the result becomes visible.

A feature with no clear place in a journey is likely to become isolated.

---

# 7. Every Feature Must Have a Home

Before implementation, fill out this mini-spec:

## Feature Cohesion Check

**Feature:**  
<!-- Name -->

**User problem:**  
<!-- Real problem, not implementation -->

**Existing object it belongs to:**  
<!-- Prefer an existing object -->

**Existing workflow it extends:**  
<!-- Where does it fit? -->

**Entry point:**  
<!-- How does the user naturally discover/use it? -->

**Result:**  
<!-- What changes after use? -->

**Where the result appears:**  
<!-- Avoid dead ends -->

**New user-facing concepts introduced:**  
<!-- Prefer zero -->

**New permanent navigation introduced:**  
<!-- Prefer zero -->

**Existing UI pattern reused:**  
<!-- Name it -->

**Can anything existing be simplified or removed because of this feature?**  
<!-- Strong features often enable subtraction -->

If these questions cannot be answered clearly, do not begin implementation yet.

---

# 8. Reuse Interaction Patterns

The product needs a consistent **interaction grammar**.

Define the standard patterns below and reuse them.

## Product interaction grammar

<!-- Customize this section for the project. -->

| Interaction | Standard pattern |
|---|---|
| Create new object | |
| Edit object | |
| Delete object | |
| View details | |
| Search | |
| Filter | |
| Sort | |
| Multi-select | |
| Bulk actions | |
| Save/reuse configuration | |
| Confirmation | |
| Error message | |
| Success feedback | |
| Empty state | |
| Loading state | |
| Contextual help | |

Do not invent a different interaction merely because it looks attractive in isolation.

A user who learns one part of the application should become better at using the rest of it.

---

# 9. Reuse Visual Patterns

New screens should look like they belong to the same product.

Do not independently redesign:

- cards;
- tables;
- toolbars;
- dialogs;
- drawers;
- forms;
- tabs;
- dropdowns;
- empty states;
- loading states;
- notifications;
- buttons;
- status indicators.

Before creating a new component, search the codebase for an existing equivalent.

## Component rule

Prefer:

```text
Existing component
    + configuration
    + extension
```

over:

```text
New bespoke component
```

unless the interaction is genuinely different.

Do not copy/paste and slightly modify a component when it should be generalized.

---

# 10. Avoid Architectural Duplication

UI fragmentation often reflects code fragmentation.

Before adding a new subsystem, search for existing:

- services;
- stores;
- state models;
- parsers;
- API wrappers;
- persistence logic;
- file handling;
- validation;
- export logic;
- history systems;
- configuration storage.

Watch for patterns such as:

```text
fileStore
uploadStore
workspaceFileStore
recentFileStore
```

when one shared model could exist.

Or:

```text
exportService
downloadService
conversionExportService
batchExportService
```

with overlapping responsibilities.

## Rule

A new feature should preferably extend a shared domain model rather than create a parallel implementation.

When duplication is discovered, consider refactoring before adding further functionality.

---

# 11. One Source of Truth

The same concept should not be independently stored in several places.

For every important piece of state, determine:

- canonical owner;
- canonical representation;
- persistence location;
- derived views.

Prefer:

```text
canonical state
    ↓
derived UI
```

over:

```text
screen A state
screen B state
screen C state
```

that gradually drift apart.

If multiple screens manipulate the same thing, they should operate on the same underlying model.

---

# 12. Avoid Dead-End Features

A feature should not end with:

> Done.

and leave the user wondering what happened.

After an action, provide an obvious continuation.

Examples:

```text
Import
  ↓
Inspect
```

```text
Validate
  ↓
Review issues
  ↓
Fix
```

```text
Create workflow
  ↓
Run workflow
```

```text
Export
  ↓
Open / download / continue working
```

Every major interaction should answer:

> **What would the user naturally want to do next?**

---

# 13. Minimize Concept Count

Product simplicity is not merely a small number of features.

A powerful product can contain many capabilities while exposing few concepts.

A useful mental metric is:

```text
Product clarity ≈ useful capability / concepts the user must learn
```

When adding functionality:

- increase capability;
- keep concept count stable where possible.

Before adding a new concept, check whether the capability can be expressed through:

- an action;
- a state;
- a property;
- a mode;
- a filter;
- a contextual control;
- an extension of an existing object.

---

# 14. Naming Rules

Naming is architecture for the user's mind.

Use one term for one concept.

Do not casually alternate between:

- item / record / entry;
- workflow / pipeline / recipe;
- preset / template / configuration;
- project / workspace;
- run / job / task;

unless they genuinely mean different things.

## Naming checklist

Before introducing UI text:

1. Search the project for related terminology.
2. Reuse existing language.
3. Prefer concrete nouns and clear verbs.
4. Avoid unnecessary technical jargon.
5. Avoid creating branded names for ordinary functionality.
6. Ensure the same action uses the same verb everywhere.

Maintain a glossary if the application becomes complex.

---

# 15. Progressive Disclosure

Do not expose every capability at once.

Show the controls needed for the current task.

Advanced options should appear:

- contextually;
- progressively;
- after the user expresses intent;
- inside an appropriate advanced section when necessary.

Avoid home screens and toolbars full of every available function.

The user should feel:

> "This gives me exactly what I need."

rather than:

> "This software can apparently do everything."

---

# 16. Dashboard Restraint

Do not automatically add dashboard widgets for new features.

A dashboard is not a dumping ground for functionality.

Every dashboard element must answer one of these:

- What needs the user's attention?
- What should the user do next?
- What recent work might they continue?
- What important state deserves immediate awareness?

Avoid decorative statistics unless they materially aid decisions.

Avoid large collections of:

- quick actions;
- promotional cards;
- tips;
- feature shortcuts;
- redundant navigation;
- vanity metrics.

A good home screen may be very simple.

---

# 17. AI Features Must Follow the Same Rules

Do not bolt an "AI Assistant" onto the application merely because AI functionality exists.

AI should participate in existing workflows.

Prefer:

> Select data → "Explain these issues"

over:

> Open AI page → manually describe the data again

Prefer:

> Document → "Summarize"

over:

> Copy document → Assistant page → paste → summarize

AI should inherit context from the product.

Avoid creating a parallel AI version of the application.

---

# 18. New Feature Decision Framework

Before implementing any meaningful feature, score it mentally against these questions.

### A. Product fit

- Does this directly support the primary user?
- Does it support the primary or a clearly important secondary job?
- Does it fit the existing product model?

### B. Conceptual cost

- Does it introduce a new noun?
- Does it create a new type of object?
- Does the user need to learn new terminology?

### C. Interface cost

- Does it require permanent navigation?
- Does it require a new interaction pattern?
- Does it duplicate controls already present elsewhere?

### D. Architectural cost

- Does it create parallel state?
- Does it duplicate a service?
- Does it introduce another representation of the same data?

### E. Simplification opportunity

- Can this replace an older feature?
- Can this merge two existing concepts?
- Can it remove a screen?
- Can it make an existing workflow shorter?

Prefer features with high user value and low conceptual/interface cost.

---

# 19. Subtraction Is Development

Removing things is valid product work.

Periodically identify:

- duplicate concepts;
- redundant pages;
- obsolete controls;
- unused settings;
- unnecessary dashboard cards;
- repeated actions;
- screens that can become dialogs or panels;
- separate tools that should become one workflow;
- labels that can be unified;
- state that can be derived rather than stored.

Do not preserve complexity merely because code already exists.

The cost of maintaining a confusing feature may exceed its implementation cost.

---

# 20. Mandatory Cohesion Audit

Run this audit periodically and after major feature batches.

## 20.1 Concept audit

Search for concepts that mean approximately the same thing.

Examples:

```text
template
preset
saved configuration
profile
recipe
workflow
```

For each cluster:

- define the difference;
- merge concepts whose distinction does not benefit users;
- standardize terminology.

---

## 20.2 Navigation audit

List every permanent navigation item.

For each one ask:

1. Is this truly a destination?
2. Could it be accessed contextually?
3. Does it represent a major product object/domain?
4. Is it duplicating another area?
5. Can it become an action rather than a page?

Aim to reduce navigation where possible.

---

## 20.3 Workflow audit

Identify the product's five most important user journeys.

For each journey:

- trace every screen;
- count unnecessary transitions;
- identify repeated data entry;
- identify context loss;
- identify unclear next steps;
- identify features that pull the user out of the workflow.

Prefer continuous journeys.

---

## 20.4 Interaction audit

Find every implementation of:

- create;
- edit;
- delete;
- search;
- filtering;
- sorting;
- selection;
- bulk actions;
- save;
- export;
- confirmation;
- errors;
- success feedback.

Check whether equivalent actions behave consistently.

Unify unnecessarily different patterns.

---

## 20.5 Visual audit

Compare major screens for:

- spacing;
- card style;
- button hierarchy;
- typography;
- icon usage;
- form layout;
- table behavior;
- empty states;
- headers;
- dialogs;
- drawers;
- feedback messages.

Do not redesign each screen independently.

---

## 20.6 State audit

Search for multiple representations of the same domain state.

Check for:

- duplicated stores;
- duplicated persistence;
- UI-local copies of canonical state;
- stale derived state;
- duplicate caches;
- parallel history systems.

Move toward a clear source of truth.

---

## 20.7 Code architecture audit

Search for overlapping:

- utilities;
- components;
- services;
- hooks;
- stores;
- models;
- API clients;
- transformations;
- validators;
- exporters.

When several implementations solve the same domain problem, consolidate them.

---

## 20.8 Dead-end audit

Identify actions after which the user has no obvious next step.

For each:

- expose the result;
- provide a logical continuation;
- preserve user context;
- avoid forcing navigation back to the beginning.

---

# 21. Cohesion Audit Output Format for AI Agents

When asked to perform a product cohesion audit, do **not** immediately modify code.

First return findings using this structure:

## Executive Summary

Explain the main sources of fragmentation in plain language.

## Critical Cohesion Problems

For each:

### Problem

What is fragmented or duplicated?

### Evidence

Files, components, routes, state, or UI involved.

### User impact

Why does this make the product harder to understand or use?

### Root cause

What architectural/product decision caused it?

### Recommended model

How should the concepts work instead?

### Proposed change

Specific refactor.

### Risk

Low / Medium / High.

---

## Consolidation Opportunities

Identify places where:

```text
A + B + C
```

could become:

```text
one shared concept
```

---

## Navigation Reduction Opportunities

Identify screens that could become:

- contextual actions;
- drawers;
- dialogs;
- object subviews;
- selection actions;
- settings within an existing workflow.

---

## Terminology Conflicts

Return a table:

| Current terms | Recommended term | Reason |
|---|---|---|
| | | |

---

## Architectural Duplication

Return:

| Duplicate systems | Shared abstraction proposed |
|---|---|
| | |

---

## Recommended Product Model

Show the proposed ontology:

```text
Primary Object
 ├─ Related Object
 ├─ Related Object
 └─ Action / Workflow
```

Then show the primary flow:

```text
Start
  ↓
...
  ↓
Outcome
```

---

## Refactor Order

Order recommendations by:

1. foundational model;
2. state/data consolidation;
3. navigation;
4. workflows;
5. components;
6. visual polish.

Do not begin with cosmetic changes when the underlying model is fragmented.

---

# 22. Instructions Before Writing Code

When the user asks for a new feature:

### Step 1 — Inspect

Inspect relevant:

- routes;
- components;
- domain models;
- stores;
- services;
- terminology;
- existing related functionality.

Do not assume the feature needs a new subsystem.

### Step 2 — Place

Identify where the feature belongs in the existing product model.

### Step 3 — Reuse

Look for existing:

- objects;
- components;
- actions;
- services;
- data models;
- state;
- UI patterns.

### Step 4 — Simplify

Ask whether the feature can make anything else unnecessary.

### Step 5 — Implement

Only after the above, implement the smallest coherent solution.

### Step 6 — Recheck

Verify that the change:

- did not add unnecessary navigation;
- did not introduce duplicate terminology;
- did not create parallel state;
- did not introduce a one-off interaction;
- did not create a dead end;
- still feels native to the rest of the product.

---

# 23. Instructions When Asked to "Add X"

Do not interpret:

> "Add X"

as:

> "Create a new page called X."

Instead interpret it as:

> "Add capability X to the product in the most coherent way possible."

The implementation may be:

- an action;
- a button;
- a context menu option;
- a property;
- a panel;
- a workflow step;
- a new state;
- a reusable configuration;
- an extension of an existing screen.

A new page is only one possible solution.

---

# 24. Instructions When Asked to Redesign a Screen

Do not optimize the screen in isolation.

Before redesigning:

1. inspect neighboring screens;
2. identify the shared design grammar;
3. identify reusable components;
4. preserve established interaction patterns;
5. determine the screen's role in the user's workflow.

The goal is not:

> "Make this screen beautiful."

The goal is:

> "Make this screen a beautiful, natural part of this product."

---

# 25. Instructions When AI Detects Existing Fragmentation

If the codebase already contains fragmentation:

Do not blindly extend it.

Flag cases such as:

- duplicate product concepts;
- competing state systems;
- overlapping components;
- similar features in multiple locations;
- conflicting terminology;
- unnecessary routes.

If the requested feature would make the fragmentation significantly worse, prefer a small foundational refactor as part of the implementation.

Do not perform a huge unrelated rewrite unless necessary.

Use incremental consolidation.

---

# 26. Product Architecture Before Screen Architecture

Always reason in this order:

```text
User problem
    ↓
Product object
    ↓
Domain relationship
    ↓
Workflow
    ↓
Interaction
    ↓
Screen
    ↓
Component
```

Do not reason backwards from:

```text
"We need a screen for..."
```

A screen is an implementation detail.

---

# 27. Default Biases

When uncertain, prefer:

**Fewer concepts** over more concepts.

**Existing objects** over new objects.

**Contextual actions** over new pages.

**Shared components** over bespoke components.

**Shared state** over parallel state.

**Workflow continuity** over feature isolation.

**Simple navigation** over complete navigation.

**Progressive disclosure** over showing every option.

**One strong primary action** over many equal actions.

**Removing duplication** over documenting duplication.

**Refactoring the product model** over explaining a confusing model.

---

# 28. Red Flags

Stop and reconsider if implementation introduces several of these:

- new top-level navigation item;
- new noun users must learn;
- new store for similar state;
- new service overlapping an existing service;
- new standalone configuration system;
- new component similar to an existing component;
- duplicated form fields;
- repeated file/data selection;
- different terminology for the same thing;
- a feature-specific dashboard;
- a feature-specific history system;
- a feature-specific settings page;
- copying information between areas manually;
- isolated AI chat disconnected from application context;
- a wizard where existing patterns do not use wizards;
- a modal/drawer pattern inconsistent with the rest of the app.

Multiple red flags indicate the feature probably needs to be integrated differently.

---

# 29. Signs of a Healthy Product

The product is becoming more coherent when:

- new features often require little or no new navigation;
- users can predict how unfamiliar screens work;
- the same concepts appear throughout the system;
- one action naturally leads to the next;
- capabilities reuse existing data/context;
- advanced power grows without cluttering basic workflows;
- the number of reusable components increases;
- duplicate services/stores decrease;
- major workflows become shorter;
- terminology becomes more consistent;
- features feel inevitable rather than bolted on.

---

# 30. Final Test

Before considering a feature complete, ask:

> If a user had already learned the rest of this product, would this feature feel immediately familiar?

And:

> Does this make the product feel more like one system, or more like a collection of tools?

If the answer to the second question is "collection of tools", the implementation is not finished.

---

# 31. Standing Instruction to AI Agents

You are not merely responsible for fulfilling individual feature requests.

You are also responsible for protecting the coherence of the product.

When implementing changes:

1. understand the existing product model;
2. preserve established terminology;
3. reuse established interactions;
4. prefer extending existing objects;
5. minimize new concepts;
6. minimize permanent UI;
7. consolidate duplication when practical;
8. preserve workflow continuity;
9. keep one source of truth;
10. actively look for opportunities to simplify.

**Do not maximize the number of features implemented.**

Maximize:

> **useful capability delivered through the smallest coherent product model.**

The intended result is software that feels deliberately designed as a whole, even when much of it is built with AI.
