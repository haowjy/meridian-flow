/**
 * S3 implementation of the object-store port: put/get/delete via the AWS S3 SDK
 * and presigned URLs for signed reads. Owns the S3-specific wiring (bucket,
 * client, presigning); depends inward on the port and URL helper.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createObjectStorageUrl } from "../../object-storage-url.js";
import type {
  ObjectStoreErrorCode,
  ObjectStorePort,
  ObjectStoreResult,
} from "../../ports/object-store.js";

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (e.g. MinIO `http://localhost:9000`). */
  endpoint?: string;
  /**
   * Endpoint used when signing read URLs, if it must differ from `endpoint` to be
   * reachable by the browser (e.g. an HTTPS proxy in front of MinIO). Defaults to `endpoint`.
   */
  publicEndpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Path-style addressing — required for MinIO and most non-AWS S3 stores. */
  forcePathStyle?: boolean;
  signedUrlTtlSeconds: number;
  /** Create the bucket on first use if it is missing. Dev/MinIO only — never in prod. */
  createBucketIfMissing?: boolean;
}

function ok<T>(value: T): ObjectStoreResult<T> {
  return { ok: true, value };
}

function err(code: ObjectStoreErrorCode, message: string): ObjectStoreResult<never> {
  return { ok: false, error: { code, message } };
}

const SAFE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_:+=.,@-]*$/;

function isSafeKey(key: string): boolean {
  return SAFE_KEY_RE.test(key) && !key.split("/").some((part) => part === ".." || part === "");
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

function clientConfig(opts: S3ObjectStoreOptions, endpoint?: string) {
  return {
    region: opts.region,
    ...(endpoint ? { endpoint } : {}),
    ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
  };
}

export class S3ObjectStoreAdapter implements ObjectStorePort {
  private readonly client: S3Client;
  /** Separate client for presigning when the public endpoint differs from the internal one. */
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;
  private readonly createBucketIfMissing: boolean;
  private bucketEnsured = false;

  constructor(opts: S3ObjectStoreOptions) {
    this.client = new S3Client(clientConfig(opts, opts.endpoint));
    this.presignClient =
      opts.publicEndpoint && opts.publicEndpoint !== opts.endpoint
        ? new S3Client(clientConfig(opts, opts.publicEndpoint))
        : this.client;
    this.bucket = opts.bucket;
    this.signedUrlTtlSeconds = opts.signedUrlTtlSeconds;
    this.createBucketIfMissing = opts.createBucketIfMissing ?? false;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<ObjectStoreResult<{ storageUrl: string }>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    const ensured = await this.ensureBucket();
    if (!ensured.ok) return ensured;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
        }),
      );
      return ok({ storageUrl: createObjectStorageUrl(key) });
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to write object");
    }
  }

  async get(key: string): Promise<ObjectStoreResult<{ bytes: Uint8Array; mimeType: string }>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = response.Body;
      if (!body) return err("not_found", "Object not found");
      const bytes = await body.transformToByteArray();
      return ok({
        bytes,
        mimeType: response.ContentType ?? "application/octet-stream",
      });
    } catch (error) {
      if (isNotFound(error)) return err("not_found", "Object not found");
      return err("io_error", error instanceof Error ? error.message : "Failed to read object");
    }
  }

  async list(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<
    ObjectStoreResult<{
      keys: Array<{ key: string; sizeBytes: number; mimeType?: string }>;
      cursor?: string;
    }>
  > {
    if (!isSafeKey(prefix) && prefix !== "")
      return err("invalid_key", "Object key prefix is invalid");

    const limit = options?.limit ?? 1_000;
    try {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: options?.cursor,
          MaxKeys: limit,
        }),
      );
      const keys =
        response.Contents?.filter((entry) => entry.Key && entry.Key.length > 0).map((entry) => ({
          key: entry.Key as string,
          sizeBytes: entry.Size ?? 0,
        })) ?? [];
      return ok({
        keys,
        ...(response.IsTruncated && response.NextContinuationToken
          ? { cursor: response.NextContinuationToken }
          : {}),
      });
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to list objects");
    }
  }

  async getSignedUrl(key: string): Promise<ObjectStoreResult<string>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return err("not_found", "Object not found");
      return err("io_error", error instanceof Error ? error.message : "Failed to stat object");
    }

    try {
      const url = await getSignedUrl(
        this.presignClient,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: this.signedUrlTtlSeconds },
      );
      return ok(url);
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to sign URL");
    }
  }

  async delete(key: string): Promise<ObjectStoreResult<void>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return ok(undefined);
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to delete object");
    }
  }

  private async ensureBucket(): Promise<ObjectStoreResult<void>> {
    if (this.bucketEnsured) return ok(undefined);

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketEnsured = true;
      return ok(undefined);
    } catch (error) {
      if (!isNotFound(error)) {
        // A non-404 (auth/network) error is surfaced; don't mask it as "missing".
        return err("io_error", error instanceof Error ? error.message : "Failed to reach bucket");
      }
    }

    if (!this.createBucketIfMissing) {
      return err("io_error", `Bucket "${this.bucket}" does not exist`);
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.bucketEnsured = true;
      return ok(undefined);
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to create bucket");
    }
  }
}

export function createS3ObjectStore(opts: S3ObjectStoreOptions): ObjectStorePort {
  return new S3ObjectStoreAdapter(opts);
}
