// Production ConditionalStore backed by real Cloudflare R2, via its
// S3-compatible API. NOT exercised against a real R2 bucket by this
// repo's own tests (no Cloudflare credentials in this environment, same
// honesty boundary as deploy/README.md draws for the Litestream config) —
// what IS verified is that this correctly maps the ConditionalStore
// interface onto the exact conditional-write semantics R2 actually
// supports (confirmed against developers.cloudflare.com/r2/api/s3/api/,
// 2026-08-23): PutObject supports If-Match/If-None-Match; DeleteObject
// supports neither, which is why distributed-lock.ts never deletes.
//
// Before trusting this against a real bucket, run it through the same
// race/TTL/crash scenarios test/distributed-lock.test.ts proves against
// LocalFileConditionalStore, pointed at a real bucket instead.

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  NoSuchKey,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { ConditionalStore, ConditionalWriteResult, StoredObject } from "./conditional-store.js";

export interface R2ConditionalStoreOptions {
  bucket: string;
  /** https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

async function streamToString(body: unknown): Promise<string> {
  // The S3 SDK's Body type varies by runtime (web stream vs Node stream);
  // its own documented helper for exactly this is `transformToString()` on
  // the Node runtime's response body.
  return (body as { transformToString(): Promise<string> }).transformToString();
}

export class R2ConditionalStore implements ConditionalStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: R2ConditionalStoreOptions) {
    const config: S3ClientConfig = {
      region: "auto",
      endpoint: opts.endpoint,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    };
    this.client = new S3Client(config);
    this.bucket = opts.bucket;
  }

  async get(key: string): Promise<StoredObject | undefined> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const value = await streamToString(response.Body);
      const etag = response.ETag;
      if (!etag) throw new Error(`R2 GetObject for ${key} returned no ETag — cannot support conditional writes`);
      return { value, etag };
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  }

  async putIfAbsent(key: string, value: string): Promise<ConditionalWriteResult> {
    return this.conditionalPut(key, value, { IfNoneMatch: "*" });
  }

  async putIfMatch(key: string, value: string, expectedEtag: string): Promise<ConditionalWriteResult> {
    return this.conditionalPut(key, value, { IfMatch: expectedEtag });
  }

  private async conditionalPut(
    key: string,
    value: string,
    condition: { IfNoneMatch: string } | { IfMatch: string }
  ): Promise<ConditionalWriteResult> {
    try {
      const response = await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: value, ...condition })
      );
      if (!response.ETag) {
        throw new Error(`R2 PutObject for ${key} returned no ETag — cannot support conditional writes`);
      }
      return { outcome: "written", etag: response.ETag };
    } catch (err) {
      // The SDK surfaces R2's 412 Precondition Failed as a generic service
      // exception (there's no dedicated typed error class for it, unlike
      // NoSuchKey) — match on the HTTP status the SDK attaches instead.
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412) return { outcome: "conflict" };
      throw err;
    }
  }
}
