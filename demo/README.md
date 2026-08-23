# AgentTrust Demo

Step 3 of [project-docs/agent-trust-layer-spec.md](../project-docs/agent-trust-layer-spec.md)
§6: two toy agents (buyer + seller) driving a real transaction through
[`registry-server`](../registry-server) and [`escrow-server`](../escrow-server)
— as actual MCP servers spoken to over the actual protocol, not internal
function calls. This is the genuine end-to-end proof; the unit tests in
each service prove their own logic in isolation, this proves the two
services actually work together.

## Running it

```bash
npm install
npm run e2e
```

This spawns both servers as child processes sharing one temporary SQLite
file, generates three throwaway `did:key` identities (buyer, seller,
arbiter), hosts their signed manifests on a local HTTP server, and drives:

```
register all three agents
  → buyer creates escrow (signed, pre-selects the arbiter)
  → seller delivers
  → buyer confirms (signed release + signed review, both in one call)
  → query the seller's reputation on registry-server and assert it moved
```

Everything is cleaned up (processes killed, temp db deleted) whether the
run succeeds or fails.

## Why manifest hosting needs a workaround here

`register_agent` fetches `manifest_url` over HTTPS and refuses
localhost/private addresses (`registry-server`'s SSRF guard — see its
`identity.ts`). A real agent hosts its manifest on a real public URL; this
demo has none to give it, so it sets
`AGENTTRUST_ALLOW_LOCAL_MANIFESTS=true` when spawning the registry-server
subprocess, which fully bypasses that guard. This is a demo/test-only
escape hatch, loudly logged when active, and must never be set outside a
local dev process — see the comment on `assertSafeManifestUrl` in
`registry-server/src/identity.ts`.

## Why subprocesses, not `tsc` builds

Both servers are launched via `node --import tsx src/server.ts` rather
than a compiled `dist/`, matching how `escrow-server` itself must be run
(see its README) — `tsx` resolves the cross-package relative imports
directly against source, which a separately-compiled `dist/` layout for
each sibling package cannot do without extra build tooling this prototype
doesn't have yet.
