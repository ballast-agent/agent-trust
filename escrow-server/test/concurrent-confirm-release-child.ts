import { openDatabase } from "../../registry-server/src/db.js";
import * as escrow from "../src/tools.js";

interface ChildConfig {
  dbPath: string;
  input: escrow.ConfirmReleaseInput;
}

interface ParentMessage {
  type: "go";
}

const rawConfig = process.env.AGENTTRUST_CONCURRENCY_CHILD_CONFIG;
if (!rawConfig) {
  throw new Error("missing AGENTTRUST_CONCURRENCY_CHILD_CONFIG");
}

const config = JSON.parse(rawConfig) as ChildConfig;
const database = openDatabase(config.dbPath);
database.exec("PRAGMA busy_timeout = 2000;");

const txBeforeStart = database
  .prepare("SELECT status FROM transactions WHERE tx_id = ?")
  .get(config.input.tx_id) as { status: string } | undefined;

process.send?.({ type: "ready", status: txBeforeStart?.status ?? null });

process.on("message", (message: ParentMessage) => {
  if (message.type !== "go") return;

  try {
    const result = escrow.confirmRelease(database, config.input);
    process.send?.({ type: "result", ok: true, result });
  } catch (err) {
    process.send?.({
      type: "result",
      ok: false,
      name: (err as Error).name,
      message: (err as Error).message,
    });
  } finally {
    database.close();
    setImmediate(() => process.exit(0));
  }
});
