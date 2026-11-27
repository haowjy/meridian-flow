import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
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
import { isSafeKey, isSafeKeyPrefix } from "../../object-key.js";
import { createObjectStorageUrl } from "../../object-storage-url.js";
import type {
  ObjectStoreCopyOutput,
  ObjectStoreErrorCode,
  ObjectStoreGetOptions,
  ObjectStoreHead,
  ObjectStorePort,
  ObjectStoreProviderLinkOptions,
  ObjectStoreResult,
  ObjectStoreSignedPut,
  ObjectStoreSignedPutOptions,
  ObjectStoreSignedUrlOptions,
  ObjectStoreStreamOutput,
} from "../../ports/object-store.js";

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  signedUrlTtlSeconds: number;
  createBucketIfMissing?: boolean;
}

function ok<T>(value: T): ObjectStoreResult<T> {
  return { ok: true, value };
}

function err(code: ObjectStoreErrorCode, message: string): ObjectStoreResult<never> {
  return { ok: false, error: { code, message } };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

function clientConfig(opts: S3ObjectStoreOptions, endpoint?: string) {
  return {
    region: opts.region,
    // Disable SDK v3's default CRC32 PUT trailer; R2 rejects it
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    responseChecksumValidation: "WHEN_REQUIRED" as const,
    ...(endpoint ? { endpoint } : {}),
    ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
  };
}

export class S3ObjectStoreAdapter implements ObjectStorePort {
  private readonly client: S3Client;
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

  async get(
    key: string,
    options?: ObjectStoreGetOptions,
  ): Promise<ObjectStoreResult<{ bytes: Uint8Array; mimeType: string }>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = response.Body;
      if (!body) return err("not_found", "Object not found");
      if (
        options?.maxBytes !== undefined &&
        (response.ContentLength ?? Infinity) > options.maxBytes
      ) {
        (body as Readable).destroy();
        return err("too_large", "Object is too large to read");
      }
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

  async getStream(key: string): Promise<ObjectStoreResult<ObjectStoreStreamOutput>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return err("not_found", "Object not found");
      return ok({
        stream: response.Body as Readable,
        mimeType: response.ContentType ?? "application/octet-stream",
        sizeBytes: response.ContentLength ?? 0,
      });
    } catch (error) {
      if (isNotFound(error)) return err("not_found", "Object not found");
      return err("io_error", error instanceof Error ? error.message : "Failed to read object");
    }
  }

  async copy(fromKey: string, toKey: string): Promise<ObjectStoreResult<ObjectStoreCopyOutput>> {
    if (!isSafeKey(fromKey) || !isSafeKey(toKey))
      return err("invalid_key", "Object key is invalid");

    const ensured = await this.ensureBucket();
    if (!ensured.ok) return ensured;

    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: toKey,
          CopySource: `${this.bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
        }),
      );
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: toKey }),
      );
      return ok({
        storageUrl: createObjectStorageUrl(toKey),
        mimeType: head.ContentType ?? "application/octet-stream",
        sizeBytes: head.ContentLength ?? 0,
      });
    } catch (error) {
      if (isNotFound(error)) return err("not_found", "Object not found");
      return err("io_error", error instanceof Error ? error.message : "Failed to copy object");
    }
  }

  async readHead(key: string, headBytes: number): Promise<ObjectStoreResult<ObjectStoreHead>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    try {
      const { ContentLength: sizeBytes = 0 } = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      // S3 returns 416 for a range read of an empty object; short-circuit before GetObject
      if (sizeBytes === 0 || headBytes === 0) return ok({ head: new Uint8Array(), sizeBytes });
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${Math.min(headBytes, sizeBytes) - 1}`,
        }),
      );
      if (!response.Body) return err("not_found", "Object not found");
      return ok({ head: await response.Body.transformToByteArray(), sizeBytes });
    } catch (error) {
      if (isNotFound(error)) return err("not_found", "Object not found");
      return err("io_error", error instanceof Error ? error.message : "Failed to read object");
    }
  }

  async signPut(
    key: string,
    options: ObjectStoreSignedPutOptions,
  ): Promise<ObjectStoreResult<ObjectStoreSignedPut>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    const ensured = await this.ensureBucket();
    if (!ensured.ok) return ensured;

    try {
      const url = await getSignedUrl(
        this.presignClient,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: options.mimeType,
          ContentLength: options.sizeBytes,
        }),
        {
          expiresIn: this.signedUrlTtlSeconds,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return ok({ url, headers: { "Content-Type": options.mimeType } });
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to sign URL");
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
    if (!isSafeKeyPrefix(prefix)) return err("invalid_key", "Object key prefix is invalid");

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

  async getSignedUrl(
    key: string,
    options?: ObjectStoreSignedUrlOptions,
  ): Promise<ObjectStoreResult<string>> {
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
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(options?.contentDisposition
            ? { ResponseContentDisposition: options.contentDisposition }
            : {}),
        }),
        { expiresIn: this.signedUrlTtlSeconds },
      );
      return ok(url);
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to sign URL");
    }
  }

  async getProviderReadLink(
    key: string,
    options: ObjectStoreProviderLinkOptions,
  ): Promise<ObjectStoreResult<string | null>> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");
    try {
      const url = await getSignedUrl(
        this.presignClient,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: options.expiresInSeconds, signingDate: options.signedAt },
      );
      return ok(url.startsWith("https://") ? url : null);
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
