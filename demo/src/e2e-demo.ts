// Step 3 of project-docs/agent-trust-layer-spec.md: two toy agents (buyer +
// seller) driving a REAL transaction through registry-server and
// escrow-server as actual MCP servers speaking the actual protocol — not
// devSeedSettledTransaction, not calling internal functions directly.
//
// Both services are spawned as child processes over the MCP stdio
// transport (the SDK's Client/StdioClientTransport), exactly how a real
// buyer/seller agent would talk to them.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAgent, type TestAgent } from "../../registry-server/test/helpers.js";
import { ok, fail, connectServer, callTool } from "./mcp-clients.js";

/** Serves each test agent's manifest JSON on 127.0.0.1 for register_agent to fetch. */
function startManifestServer(agents: Record<string, TestAgent>): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const name = (req.url ?? "").replace(/^\/+/, "");
      const agent = agents[name];
      if (!agent) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agent.manifest));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("unexpected server address");
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "agenttrust-demo-"));
  const dbPath = join(dbDir, "shared.db");

  console.log("1. Generate buyer/seller/arbiter identities (did:key + signed manifests)");
  const buyer = createTestAgent({ capabilityTags: ["text.translate"], priceSchedule: { "text.translate": "0.004 USDC" } });
  const seller = createTestAgent({ capabilityTags: ["text.translate"], priceSchedule: { "text.translate": "0.004 USDC" } });
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  ok("three did:key identities generated locally, private keys never leave this process");

  console.log("2. Host their manifests locally (demo-only — real agents host these on real HTTPS URLs)");
  const manifestServer = await startManifestServer({ buyer, seller, arbiter });
  ok(`manifest server up at ${manifestServer.baseUrl}`);

  console.log("3. Start registry-server and escrow-server as real MCP subprocesses, sharing one SQLite file");
  const registryClient = await connectServer("registry", "registry-server", {
    REGISTRY_DB_PATH: dbPath,
    // Demo-only bypass — see identity.ts's resolveManifestTarget doc comment.
    // Real agents publish manifests on public HTTPS URLs; this lets the
    // demo host them on 127.0.0.1 instead of standing up real hosting.
    AGENTTRUST_ALLOW_LOCAL_MANIFESTS: "true",
  });
  const escrowClient = await connectServer("escrow", "escrow-server", { REGISTRY_DB_PATH: dbPath });
  ok("both MCP servers connected");

  try {
    console.log("4. Register all three agents via register_agent");
    for (const [name, agent] of Object.entries({ buyer, seller, arbiter })) {
      await callTool(registryClient, "register_agent", {
        manifest_url: `${manifestServer.baseUrl}/${name}`,
        wallet_address: agent.manifest.wallet_address,
        stake_amount: 50 * 0.004, // K=50 x max claimed price, see identity-and-onboarding-spec.md §3
      });
    }
    ok("buyer, seller, and arbiter all registered");

    console.log("5. Buyer creates escrow for a text.translate task, pre-selecting the arbiter");
    const createFields = {
      payer_id: buyer.agentId,
      payee_id: seller.agentId,
      amount: 0.004,
      currency: "USDC",
      task_hash: "sha256:demo-task",
      sla_seconds: 30,
      arbiter_id: arbiter.agentId,
    };
    const { tx_id } = await callTool<{ tx_id: string }>(escrowClient, "create_escrow", {
      ...createFields,
      signature: buyer.sign(createFields),
    });
    ok(`escrow created, tx_id=${tx_id}`);

    console.log("6. Seller delivers the result");
    const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:demo-result" };
    await callTool(escrowClient, "submit_deliverable", {
      ...deliverFields,
      signature: seller.sign(deliverFields),
    });
    ok("deliverable submitted");

    console.log("7. Buyer confirms — funds release, a satisfied review is recorded automatically");
    const reviewPayload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
    await callTool(escrowClient, "confirm_release", {
      tx_id,
      payer_id: buyer.agentId,
      signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
      review_signature: buyer.sign(reviewPayload),
    });
    ok("release confirmed");

    console.log("8. Query the seller's reputation on registry-server — the review must have landed");
    const reputation = await callTool<{ reputation_score: number; tx_count: number }>(
      registryClient,
      "query_reputation",
      { agent_id: seller.agentId }
    );
    if (reputation.reputation_score !== 1 || reputation.tx_count !== 1) {
      fail("reputation check", reputation);
    }
    ok(`seller reputation_score=${reputation.reputation_score}, tx_count=${reputation.tx_count}`);

    console.log("\nStep 3 exit criteria: PASSED — real end-to-end transaction through both live MCP servers");
  } finally {
    await registryClient.close();
    await escrowClient.close();
    manifestServer.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
