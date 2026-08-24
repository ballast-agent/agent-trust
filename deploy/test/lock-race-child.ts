// Child process for the genuine multi-process lock race test — mirrors
// escrow-server/test/concurrent-confirm-release-child.ts's exact pattern
// (independent process, own event loop, waits for an IPC "go" signal)
// for the same reason: proving real OS-level contention, not just
// same-process Promise.all timing luck.

import { LocalFileConditionalStore } from "../src/local-file-conditional-store.js";
import { acquireLock } from "../src/distributed-lock.js";

interface ChildConfig {
  baseDir: string;
  key: string;
  holderId: string;
  ttlMs: number;
}

const rawConfig = process.env.AGENTTRUST_LOCK_RACE_CHILD_CONFIG;
if (!rawConfig) throw new Error("missing AGENTTRUST_LOCK_RACE_CHILD_CONFIG");
const config = JSON.parse(rawConfig) as ChildConfig;
const store = new LocalFileConditionalStore(config.baseDir);

process.send?.({ type: "ready" });

process.on("message", (message: { type: string }) => {
  if (message.type !== "go") return;
  acquireLock(store, config.key, { holderId: config.holderId, ttlMs: config.ttlMs })
    .then((result) => process.send?.({ type: "result", result }))
    .catch((err) => process.send?.({ type: "result", error: String(err) }))
    .finally(() => setImmediate(() => process.exit(0)));
});
