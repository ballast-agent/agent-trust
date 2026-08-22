// MCP transport wiring only — business logic lives in tools.ts so it stays
// testable without a running protocol server (ARCHITECTURE_GUARDRAILS.md:
// keep side effects/transport at the edges).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDatabase } from "./db.js";
import * as tools from "./tools.js";

const dbPath = process.env.REGISTRY_DB_PATH ?? "registry.db";
const database = openDatabase(dbPath);

const server = new McpServer({ name: "agenttrust-registry", version: "0.1.0" });

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

server.tool(
  "register_agent",
  "Registers a new agent: fetches and cryptographically verifies its manifest_url, " +
    "checks stake_amount meets the protocol minimum for its claimed price schedule, " +
    "and returns the agent_id (a did:key derived from the manifest's own signature).",
  {
    manifest_url: z.string().url(),
    wallet_address: z.string().min(1),
    stake_amount: z.number().nonnegative(),
    principal_contact: z.string().email().optional(),
  },
  async (input) => {
    try {
      return textResult(await tools.registerAgent(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "query_reputation",
  "Looks up an agent's reputation score, transaction/dispute counts, stake, and recent " +
    "reviews. No auth required — reputation is meant to be publicly queryable.",
  { agent_id: z.string().min(1) },
  async ({ agent_id }) => {
    try {
      return textResult(tools.queryReputation(database, agent_id));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "query_by_capability",
  "Finds agents advertising a given capability tag, optionally filtered by minimum " +
    "reputation and maximum price for that capability.",
  {
    capability_tag: z.string().min(1),
    min_reputation: z.number().min(0).max(1).optional(),
    max_price: z.number().nonnegative().optional(),
  },
  async (input) => {
    try {
      return textResult(tools.queryByCapability(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "submit_review",
  "Attaches a signed review to a settled transaction. Only callable by the payer or " +
    "payee of that specific transaction; reviews cannot attach to unsettled transactions.",
  {
    tx_id: z.string().min(1),
    reviewer_id: z.string().min(1),
    outcome: z.enum(["satisfied", "partial", "failed"]),
    notes: z.string().optional(),
    signature: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(tools.submitReview(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "slash_stake",
  "Slashes an agent's stake following a confirmed dispute finding. Only callable with " +
    "a valid signed authorization from a registered arbitration-capable agent.",
  {
    agent_id: z.string().min(1),
    tx_id: z.string().min(1),
    reason: z.string().min(1),
    arbiter_id: z.string().min(1),
    authorization: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(tools.slashStake(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "get_manifest",
  "Returns an agent's capability manifest, refetching and re-verifying it from " +
    "manifest_url if the cached copy is older than the cache TTL.",
  { agent_id: z.string().min(1) },
  async ({ agent_id }) => {
    try {
      return textResult(await tools.getManifest(database, agent_id));
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
