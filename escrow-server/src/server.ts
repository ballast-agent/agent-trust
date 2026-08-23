// MCP transport wiring only — business logic lives in tools.ts. Opens the
// SAME SQLite file as registry-server (REGISTRY_DB_PATH must match between
// the two processes) rather than its own database — see tools.ts's header
// comment for why a separate escrow database would violate "one source of
// truth."

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDatabase } from "../../registry-server/src/db.js";
import * as tools from "./tools.js";

const dbPath = process.env.REGISTRY_DB_PATH ?? "../registry-server/registry.db";
const database = openDatabase(dbPath);

const server = new McpServer({ name: "agenttrust-escrow", version: "0.1.0" });

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

server.tool(
  "create_escrow",
  "Locks funds under a new tx_id for a payer/payee pair, with a pre-selected arbiter " +
    "(per agent-trust-layer-spec.md §4, chosen at creation time so neither side can shop " +
    "for a friendlier arbiter later). Optionally refuses to escrow if the payee's " +
    "reputation is below the payer's configured floor.",
  {
    payer_id: z.string().min(1),
    payee_id: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().min(1),
    task_hash: z.string().min(1),
    sla_seconds: z.number().int().positive(),
    arbiter_id: z.string().min(1),
    min_payee_reputation: z.number().min(0).max(1).optional(),
    signature: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(tools.createEscrow(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "submit_deliverable",
  "Payee submits the deliverable_hash for an escrowed transaction, moving it to " +
    "awaiting-confirmation status.",
  {
    tx_id: z.string().min(1),
    payee_id: z.string().min(1),
    deliverable_hash: z.string().min(1),
    signature: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(tools.submitDeliverable(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "confirm_release",
  "Payer confirms a delivered result, releasing escrowed funds to the payee and " +
    "automatically recording a satisfied review — requires the payer's signature over " +
    "both the release and the review, since the Escrow Layer never holds agent keys.",
  {
    tx_id: z.string().min(1),
    payer_id: z.string().min(1),
    signature: z.string().min(1),
    review_signature: z.string().min(1),
    review_notes: z.string().optional(),
  },
  async (input) => {
    try {
      return textResult(tools.confirmRelease(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "raise_dispute",
  "Either party flags a transaction as disputed, freezing it until the pre-selected " +
    "arbiter resolves it.",
  {
    tx_id: z.string().min(1),
    disputer_id: z.string().min(1),
    reason: z.string().min(1),
    signature: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(tools.raiseDispute(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "resolve_dispute",
  "The pre-selected arbiter resolves a disputed transaction: release to payee, refund " +
    "to payer, or slash the payee's stake (delegates to the Registry's slash_stake tool).",
  {
    tx_id: z.string().min(1),
    outcome: z.enum(["release", "refund", "slash"]),
    reason: z.string().min(1),
    arbiter_id: z.string().min(1),
    authorization: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(await tools.resolveDispute(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "reclaim_expired",
  "Payer reclaims escrowed funds after the SLA deadline passes with no delivery.",
  {
    tx_id: z.string().min(1),
    payer_id: z.string().min(1),
    signature: z.string().min(1),
  },
  async (input) => {
    try {
      return textResult(tools.reclaimExpired(database, input));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "sweep_auto_release",
  "Releases any delivered-but-unconfirmed transactions past the auto-release grace " +
    "window (agent-trust-layer-spec.md §3 step 5). Intended to be called periodically " +
    "by a scheduler; not built into this prototype. Note: auto-released transactions do " +
    "not get an automatic review, since the Escrow Layer has no payer signature to offer " +
    "— see tools.ts's sweepAutoRelease comment.",
  { grace_ms: z.number().int().positive().optional() },
  async ({ grace_ms }) => {
    try {
      return textResult(tools.sweepAutoRelease(database, grace_ms));
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
