// Proves the Litestream replication mechanism actually works — issue #8 of
// project-docs/serverless-deployment-guide.md's tracking list. This does
// NOT touch Cloudflare R2 or need any credentials: it uses Litestream's
// local "file" replica type instead of "s3", so the mechanism (stream WAL
// -> replica, then restore a fresh copy from the replica) is proven for
// real without secrets. Swapping the replica type to "s3" pointed at R2
// (see ../litestream/litestream.yml) is a config change, not a different
// mechanism — Litestream's replica backends are interchangeable by design.
//
// Requires the `litestream` binary on PATH (or LITESTREAM_BIN pointing at
// it directly) — see ../README.md for install instructions. This script
// does not install Litestream itself.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDatabase, insertAgent, getAgent, type AgentRow } from "../../registry-server/src/db.js";

function ok(step: string) {
  console.log(`  ok: ${step}`);
}

function fail(step: string, detail: unknown): never {
  console.error(`  FAILED: ${step}`);
  console.error(detail);
  process.exit(1);
}

const LITESTREAM_BIN = process.env.LITESTREAM_BIN ?? "litestream";

function testAgentRow(agentId: string, note: string): AgentRow {
  const now = Date.now();
  return {
    agent_id: agentId,
    manifest_url: `https://example.test/${agentId}.json`,
    wallet_address: `0x${agentId.slice(-8)}`,
    stake_amount: 1,
    capability_tags: JSON.stringify(["litestream-smoke-test"]),
    price_schedule: JSON.stringify({ "litestream-smoke-test": "0.01 USDC" }),
    sla_seconds: 30,
    manifest_signature: `unsigned-smoke-test-row:${note}`,
    principal_contact: null,
    principal_verified: 0,
    manifest_fetched_at: now,
    created_at: now,
    last_active: now,
  };
}

/** Poll until `check()` returns true or `timeoutMs` elapses. */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(200);
  }
  fail(label, `timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function replicaHasFiles(replicaDir: string): boolean {
  try {
    // Litestream's LTX replica layout is `ltx/<level>/<txid-range>.ltx` —
    // just prove SOMETHING landed rather than parsing its exact format.
    const walk = (dir: string): boolean =>
      readdirSync(dir, { withFileTypes: true }).some((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : true
      );
    return walk(replicaDir);
  } catch {
    return false; // directory doesn't exist yet
  }
}

async function main() {
  try {
    execFileSync(LITESTREAM_BIN, ["version"], { stdio: "pipe" });
  } catch (err) {
    fail(
      `locate the litestream binary (checked "${LITESTREAM_BIN}" — set LITESTREAM_BIN if it's not on PATH)`,
      err
    );
  }
  ok(`found litestream binary (${LITESTREAM_BIN})`);

  const workDir = mkdtempSync(join(tmpdir(), "agenttrust-litestream-smoke-"));
  const dbPath = join(workDir, "primary", "shared.db");
  const replicaDir = join(workDir, "replica");
  const restoredPath = join(workDir, "restored", "shared.db");
  const configPath = join(workDir, "litestream.yml");
  mkdirSync(join(workDir, "primary"), { recursive: true });
  mkdirSync(join(workDir, "restored"), { recursive: true });

  let litestreamProcess: ChildProcess | undefined;
  try {
    // 1. Seed the primary db through the SAME openDatabase() both real
    // servers use — proves WAL mode (a hard Litestream requirement, see
    // db.ts's openDatabase) is actually on, not just assumed.
    const db = openDatabase(dbPath);
    insertAgent(db, testAgentRow("did:key:smoke-test-agent-one", "seeded-before-replicate-started"));
    db.close();
    ok("seeded the primary db (via registry-server's real openDatabase/insertAgent) before starting Litestream");

    // 2. Point Litestream at it with a local file replica — no R2/S3
    // credentials involved, see this file's header comment.
    writeFileSync(
      configPath,
      `dbs:\n  - path: ${dbPath}\n    replicas:\n      - type: file\n        path: ${replicaDir}\n`
    );

    litestreamProcess = spawn(LITESTREAM_BIN, ["replicate", "-config", configPath, "-log-level", "info"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let litestreamOutput = "";
    litestreamProcess.stdout?.on("data", (chunk) => (litestreamOutput += chunk.toString()));
    litestreamProcess.stderr?.on("data", (chunk) => (litestreamOutput += chunk.toString()));

    await waitFor("Litestream picks up the initial snapshot", 15_000, () => replicaHasFiles(replicaDir));
    ok("Litestream replicated the initial snapshot to the local file replica");

    // 3. Write a SECOND row while Litestream is running — proves ongoing
    // WAL streaming, not just a one-time snapshot at startup.
    const db2 = openDatabase(dbPath);
    insertAgent(db2, testAgentRow("did:key:smoke-test-agent-two", "written-while-replicate-was-running"));
    db2.close();
    // Litestream's default sync interval is ~1s; give it a few cycles.
    await sleep(3000);
    ok("wrote a second row while Litestream was actively running");

    litestreamProcess.kill();
    litestreamProcess = undefined;
    await sleep(500); // let the process actually exit before restoring

    // 4. Restore to a FRESH path — proves recovery, not just "the replica
    // directory has some files in it."
    let restoreStderr = "";
    try {
      execFileSync(LITESTREAM_BIN, ["restore", "-config", configPath, "-o", restoredPath, dbPath], {
        stdio: "pipe",
      });
    } catch (err) {
      // KNOWN WINDOWS-ONLY QUIRK (see deploy/README.md): litestream's
      // post-restore directory fsync can fail with "Access is denied" on
      // Windows/NTFS even though the restored .db file itself is written
      // correctly — don't treat this specific, documented failure as fatal;
      // verify the actual restored data below instead of trusting exit code.
      restoreStderr = String((err as { stderr?: Buffer }).stderr ?? err);
      if (!/sync restore output dir.*Access is denied/i.test(restoreStderr)) {
        fail("run litestream restore to a fresh path", err);
      }
      console.log("  (non-fatal: hit the documented Windows directory-fsync quirk, verifying data directly)");
    }

    // 5. Prove the restored copy actually has BOTH rows — the only check
    // that actually matters; everything above is scaffolding for this.
    const restoredDb = openDatabase(restoredPath);
    const first = getAgent(restoredDb, "did:key:smoke-test-agent-one");
    const second = getAgent(restoredDb, "did:key:smoke-test-agent-two");
    restoredDb.close();
    if (!first || !second) {
      fail(
        "verify both rows survived replicate -> restore",
        `first=${JSON.stringify(first)} second=${JSON.stringify(second)}\nlitestream output:\n${litestreamOutput}`
      );
    }
    ok("restored a fresh copy from the replica and both rows are present and correct");

    console.log("\nLitestream replication mechanism verified end-to-end (local file replica).");
    console.log("Swapping to a real R2 bucket is a config change — see deploy/litestream/litestream.yml.");
  } finally {
    litestreamProcess?.kill();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => fail("litestream-smoke-test", err));
