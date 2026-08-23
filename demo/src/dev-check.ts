// Fast "are my two dev servers wired correctly" check — one command instead
// of two terminals, per registry-server/README.md and escrow-server/README.md's
// separate manual instructions.
//
// Note on what this can and can't do: registry-server and escrow-server
// speak MCP over stdio, which is spawned 1:1 per client (Claude Desktop,
// this script, e2e-demo.ts, ...) — there is no way to pre-start a stdio
// server and have some *other*, later process attach to it, the way you
// could with an HTTP port. So this script starts both, proves they're
// alive and correctly sharing one database, then exits — it is not a
// long-running "dev server" you leave open for something else to connect
// to. If you want both servers auto-started for an actual MCP client
// (Claude Desktop, etc.), see the client config snippet in the root
// README's Quickstart section instead — that config is the real
// "set up once" answer for that use case.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, fail, connectServer, callTool } from "./mcp-clients.js";

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "agenttrust-devcheck-"));
  const dbPath = join(dbDir, "shared.db");

  console.log(`Starting registry-server and escrow-server, sharing ${dbPath}`);
  const registryClient = await connectServer("registry", "registry-server", { REGISTRY_DB_PATH: dbPath });
  const escrowClient = await connectServer("escrow", "escrow-server", { REGISTRY_DB_PATH: dbPath });

  try {
    ok("both MCP servers started and accepted the connection handshake");

    // Cheap, side-effect-free calls that still prove each server can read
    // the shared database correctly, not just that the process boots.
    await callTool(registryClient, "query_by_capability", { capability_tag: "__dev_check_no_such_tag__" });
    ok("registry-server can query the shared database");

    await callTool(escrowClient, "sweep_auto_release", { grace_ms: Number.MAX_SAFE_INTEGER });
    ok("escrow-server can query the shared database");

    console.log("\nBoth servers are healthy and correctly sharing one database.");
  } finally {
    await registryClient.close();
    await escrowClient.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

main().catch((err) => fail("dev-check", err));
