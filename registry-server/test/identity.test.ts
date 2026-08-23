// Coverage for the manifest-fetch security path in src/identity.ts:
// single-resolution pinning (the DNS-rebinding fix), URL validation rules,
// and the pinned HTTP GET itself, exercised end-to-end against a local
// server behind AGENTTRUST_ALLOW_LOCAL_MANIFESTS=true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveManifestTarget,
  fetchAndVerifyManifest,
  ManifestVerificationError,
} from "../src/identity.js";
import type { Manifest } from "../src/identity.js";
import { createTestAgent } from "./helpers.js";

function publicFakeLookup(address = "203.0.113.7") {
  return async () => ({ address, family: address.includes(":") ? 6 : 4 });
}

async function withLocalManifestsAllowed<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENTTRUST_ALLOW_LOCAL_MANIFESTS;
  process.env.AGENTTRUST_ALLOW_LOCAL_MANIFESTS = "true";
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTTRUST_ALLOW_LOCAL_MANIFESTS;
    } else {
      process.env.AGENTTRUST_ALLOW_LOCAL_MANIFESTS = previous;
    }
  }
}

interface StartedServer {
  urlBase: string;
  close(): Promise<void>;
}

/** Local HTTP server bound to 127.0.0.1; handler may be swapped mid-test. */
async function startLocalServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<StartedServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    urlBase: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("resolveManifestTarget resolves exactly once and pins that address", async () => {
  let lookups = 0;
  const target = await resolveManifestTarget("https://rebind.example.test/manifest.json", {
    lookup: async () => {
      lookups++;
      return { address: "203.0.113.7", family: 4 };
    },
  });

  assert.equal(lookups, 1, "a second DNS resolution would reopen the rebinding window");
  assert.equal(target.address, "203.0.113.7");
  assert.equal(target.family, 4);
});

test("resolveManifestTarget rejects a plain-http manifest_url", async () => {
  await assert.rejects(
    () => resolveManifestTarget("http://example.test/manifest.json", { lookup: publicFakeLookup() }),
    /must use https/
  );
});

test("resolveManifestTarget rejects localhost", async () => {
  await assert.rejects(
    () =>
      resolveManifestTarget("https://localhost/manifest.json", {
        lookup: publicFakeLookup("127.0.0.1"),
      }),
    /localhost/
  );
});

test("resolveManifestTarget rejects private and reserved ranges", async () => {
  const reserved = [
    "10.1.2.3",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "172.16.0.9",
    "172.31.255.255",
    "192.168.1.1",
  ];
  for (const address of reserved) {
    await assert.rejects(
      () =>
        resolveManifestTarget("https://attacker.example.test/manifest.json", {
          lookup: async () => ({ address, family: 4 }),
        }),
      new RegExp(address.replace(/\./g, "\\."))
    );
  }

  for (const address of ["::1", "fd12::1"]) {
    await assert.rejects(
      () =>
        resolveManifestTarget("https://attacker.example.test/manifest.json", {
          lookup: async () => ({ address, family: 6 }),
        }),
      /non-public/
    );
  }
});

test("resolveManifestTarget accepts a public address at the private-range boundary", async () => {
  const target = await resolveManifestTarget("https://example.test/manifest.json", {
    lookup: publicFakeLookup("172.32.0.1"),
  });
  assert.equal(target.address, "172.32.0.1");
});

test("AGENTTRUST_ALLOW_LOCAL_MANIFESTS skips validation but still pins a resolved address", async () => {
  await withLocalManifestsAllowed(async () => {
    // No injected lookup: exercises the real resolver against localhost.
    const target = await resolveManifestTarget("http://localhost/manifest.json");
    assert.ok(target.address === "127.0.0.1" || target.address === "::1");
  });
});

test("fetchAndVerifyManifest verifies a correctly signed manifest served over the pinned connection", async () => {
  await withLocalManifestsAllowed(async () => {
    const agent = createTestAgent();
    const server = await startLocalServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(agent.manifest));
    });
    try {
      const manifest = await fetchAndVerifyManifest(`${server.urlBase}/manifest.json`);
      assert.equal(manifest.agent_id, agent.agentId);
    } finally {
      await server.close();
    }
  });
});

test("fetchAndVerifyManifest rejects a manifest whose body was tampered with", async () => {
  await withLocalManifestsAllowed(async () => {
    const agent = createTestAgent();
    const tampered: Manifest = {
      ...agent.manifest,
      price_schedule: { "csv-parsing": "999 USDC" },
    };
    const server = await startLocalServer((req, res) => {
      res.end(JSON.stringify(tampered));
    });
    try {
      await assert.rejects(
        () => fetchAndVerifyManifest(`${server.urlBase}/manifest.json`),
        ManifestVerificationError
      );
    } finally {
      await server.close();
    }
  });
});

test("fetchAndVerifyManifest refuses redirects instead of following them", async () => {
  await withLocalManifestsAllowed(async () => {
    const server = await startLocalServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "https://evil.example.test/manifest.json");
      res.end();
    });
    try {
      await assert.rejects(
        () => fetchAndVerifyManifest(`${server.urlBase}/manifest.json`),
        /redirect/
      );
    } finally {
      await server.close();
    }
  });
});

test("fetchAndVerifyManifest refuses oversized responses", async () => {
  await withLocalManifestsAllowed(async () => {
    const server = await startLocalServer((req, res) => {
      res.end(Buffer.alloc(1024 * 1024 + 1));
    });
    try {
      await assert.rejects(
        () => fetchAndVerifyManifest(`${server.urlBase}/manifest.json`),
        /exceeded/
      );
    } finally {
      await server.close();
    }
  });
});

test("fetchAndVerifyManifest reports non-2xx statuses as fetch failures", async () => {
  await withLocalManifestsAllowed(async () => {
    const server = await startLocalServer((req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      await assert.rejects(
        () => fetchAndVerifyManifest(`${server.urlBase}/manifest.json`),
        /status 500/
      );
    } finally {
      await server.close();
    }
  });
});

test("fetchAndVerifyManifest rejects malformed JSON bodies", async () => {
  await withLocalManifestsAllowed(async () => {
    const server = await startLocalServer((req, res) => {
      res.end("not json");
    });
    try {
      await assert.rejects(
        () => fetchAndVerifyManifest(`${server.urlBase}/manifest.json`),
        /valid JSON/
      );
    } finally {
      await server.close();
    }
  });
});
