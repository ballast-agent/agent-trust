# SECURITY_GUARDRAILS.md

> Standing instruction for AI coding agents. Read this before implementing authentication, authorization, payments, uploads, APIs, admin functions, external integrations, or anything involving sensitive/user-owned data.

## Core principle
A successful UI interaction does not prove a feature is secure.

Never assume:

```text
hidden button = protected action
disabled control = authorization
logged in = allowed
unguessable ID = secure
client validation = trustworthy
```

All sensitive decisions must be enforced at the trusted boundary.

## Authentication is not authorization
Authentication answers **who is this?** Authorization answers **may this user perform this action on this resource?**

Every sensitive server operation must verify authorization.

```text
user authenticated
    ↓
load requested resource
    ↓
verify ownership / role / permission
    ↓
perform operation
```

Do not rely on the client to send a trusted `userId`, role, price, entitlement, quota, or ownership claim.

## Server authority
The client is untrusted. Recompute or validate authoritative values server-side.

Never trust client-provided:

- identity;
- role;
- ownership;
- price;
- subscription level;
- quota;
- permissions;
- file type;
- calculated totals;
- status transitions.

## Resource ownership
For user-owned resources, never fetch solely by ID and assume the requester may access it.

Prefer ownership-aware queries where practical:

```text
WHERE id = ? AND owner_id = current_user
```

rather than loading by ID and forgetting the ownership check later.

## Deny by default
Permission systems should default to no access. Unknown or malformed permission state should fail closed for sensitive operations.

## Cover every entry point
If an action exists through UI, API, background job, webhook, mobile client, automation, or admin surface, authorization must remain correct across every path.

Centralize policy where practical.

## Secrets
Never place secrets in:

- frontend bundles;
- public environment variables;
- committed source;
- logs;
- analytics;
- error messages;
- sample config containing real values.

Use proper environment/secret management for API keys, DB credentials, signing keys, webhook secrets, and private tokens.

## Input validation
Validate untrusted input at trusted boundaries.

Check as relevant:

- type;
- length;
- shape;
- range;
- allowed values;
- ownership references;
- file size/type;
- encoding;
- URL;
- date;
- identifier format.

Client validation improves UX. Server validation provides security.

## Injection safety
Use safe rendering, parameterized queries, and framework-safe APIs. Avoid unsafe string construction for SQL, shell commands, HTML, file paths, URLs, and templates.

Treat user-controlled content as data, not executable instructions.

## Database safety
Protect against SQL injection, mass assignment, unauthorized joins, overbroad updates, and accidental full-table operations.

For update endpoints, whitelist mutable fields. Do not blindly spread request bodies into persistence operations.

## File uploads
Treat uploads as hostile.

Validate:

- size;
- extension;
- detected type where practical;
- filename;
- storage path;
- parsing limits.

Prevent path traversal. Do not execute untrusted uploads. Consider malformed files, archive bombs, oversized documents, and parser vulnerabilities.

## URLs and redirects
Validate user-controlled URLs. Protect against open redirects, SSRF, dangerous schemes, internal-network access, and credential leakage.

Prefer allowlisted redirect destinations or validated same-origin paths.

## Payments
Never trust prices calculated by the client.

Server-side logic determines product, price, currency, discounts, quantities, and entitlement.

Payment success should come from trusted provider state/server verification. Do not activate paid access because the client reports success.

## Webhooks
For webhooks:

- verify signatures;
- reject invalid signatures/timestamps;
- handle duplicate delivery;
- make processing idempotent;
- validate event type/state;
- tolerate out-of-order events where relevant.

Assume events may arrive more than once.

## Sessions and tokens
Use secure framework/provider defaults and consider expiration, refresh, revocation, secure cookies, HttpOnly, SameSite, CSRF protection, token storage, and logout invalidation.

Do not weaken secure defaults for convenience.

## Rate limiting and abuse
Any public or expensive action should consider rate limits, quotas, brute-force protection, spam controls, upload limits, and paid API/AI usage caps.

Do not expose unbounded paid operations.

## Error messages
Do not expose stack traces, SQL, internal schemas, secret values, private paths, or sensitive authorization internals to users.

Log diagnostic detail safely server-side; show safe client messages.

## Logging
Never log secrets or unnecessary sensitive content. Be cautious with auth headers, cookies, payment details, request bodies, uploaded documents, user content, and AI prompts.

Logs should support debugging without becoming a shadow database of private data.

## Privacy and data minimization
Before storing data ask:

1. Do we need it?
2. For how long?
3. Who can access it?
4. Is it required for the feature?
5. Can it be derived instead?
6. Can it be deleted with the source/account?

Do not collect data merely because it might be useful later.

## Dependency/supply-chain safety
Before adding dependencies, verify provenance, maintenance, maturity, and necessity. Avoid suspicious or typosquatted packages. Do not execute unknown installation scripts or copied shell commands blindly.

## Admin features
Admin capability is high risk. Admin routes/actions require explicit authorization. Audit high-impact actions where appropriate.

Do not implement admin as:

```text
if loggedIn → allow admin
```

## Destructive actions
For account deletion, workspace deletion, mass deletion, billing changes, or irreversible sharing/export, use clear confirmation and server-side authorization.

UI confirmation and authorization are different protections; both may be needed.

## AI/LLM security
If the product uses AI:

- treat model output as untrusted;
- never execute model-generated commands blindly;
- do not allow prompt injection to bypass permissions;
- use least-privilege tools;
- validate tool arguments server-side;
- do not expose secrets in prompts;
- send only necessary data to models.

An LLM must never become an authorization boundary.

## Security invariants
Examples:

```text
Users cannot access another user's private resource without explicit sharing.
Entitlements are always verified server-side.
Prices are never accepted from the client as authoritative.
Destructive mutations require authorization at the API boundary.
Webhook events are signature-verified before processing.
```

Add project-specific invariants:

- [ ] ________________________________________
- [ ] ________________________________________
- [ ] ________________________________________

## Security review before shipping
For every meaningful feature ask:

### Identity
- Who can call this?
- How is identity established?

### Permission
- Who may perform it?
- Is ownership checked?

### Input
- What untrusted data reaches the server?
- Is it validated?

### Output
- Could it expose another user's information?

### Abuse
- Can it be spammed or repeated?
- Is it expensive?

### Failure
- Does failure expose internals?

### Secrets
- Does sensitive information reach client code/logs?

### Storage
- What new data is retained?

### External services
- Are callbacks/webhooks verified?

## Security audit instructions for AI
When asked for a security audit:

1. inspect auth flow;
2. identify authorization boundaries;
3. enumerate sensitive endpoints/actions;
4. trace user-controlled input;
5. inspect database access;
6. inspect file handling;
7. inspect secrets/config;
8. inspect integrations/webhooks;
9. inspect rate limiting/abuse controls;
10. inspect logging/errors.

Return findings with severity, affected location, plausible exploit scenario, recommended fix, and regression test.

Do not present speculative vulnerabilities as confirmed facts.

## Standing instruction
Never make security "work" by hiding controls in the frontend. Never trust the client for sensitive decisions. Never weaken authorization merely to make implementation easier.

The goal is:

> **A feature that remains secure even when the user controls the client, changes parameters, repeats requests, and calls the API directly.**
