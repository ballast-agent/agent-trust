// Shared spawn/call helpers for talking to registry-server and
// escrow-server as real MCP subprocesses. Used by both e2e-demo.ts (full
// transaction flow) and dev-check.ts (fast liveness check) — factored out
// once there were two consumers, per ARCHITECTURE_GUARDRAILS.md's
// abstraction rule (don't abstract on the first use, do on the second).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

export function ok(step: string) {
  console.log(`  ok: ${step}`);
}

export function fail(step: string, detail: unknown): never {
  console.error(`  FAILED: ${step}`);
  console.error(detail);
  process.exit(1);
}

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function connectServer(
  name: string,
  dir: string,
  extraEnv: Record<string, string>
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: join(REPO_ROOT, dir),
    env: { ...cleanEnv(), ...extraEnv },
  });
  const client = new Client({ name: `demo-${name}-client`, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (text === undefined) fail(`${name}: no content returned`, result);
  const parsed = JSON.parse(text);
  if (result.isError) fail(`${name}: ${parsed.error ?? JSON.stringify(parsed)}`, parsed);
  return parsed as T;
}
