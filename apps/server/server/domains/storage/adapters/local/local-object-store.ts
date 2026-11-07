/**
 * Local-filesystem implementation of the object-store port: stores objects under
 * a base dir and mints HMAC-signed local read tokens for signed URLs. Owns the
 * on-disk layout and token signing; depends inward on the port and URL helper.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createObjectStorageUrl } from "../../object-storage-url.js";
import type {
  ObjectStoreCopyOutput,
  ObjectStoreErrorCode,
  ObjectStoreGetOptions,
  ObjectStoreHead,
  ObjectStorePort,
  ObjectStoreResult,
  ObjectStoreSignedPut,
  ObjectStoreSignedPutOptions,
  ObjectStoreSignedUrlOptions,
  ObjectStoreStreamOutput,
} from "../../ports/object-store.js";

interface LocalObjectMetadata {
  key: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface LocalObjectStoreOptions {
  rootDir: string;
  signedUrlBasePath: string;
  signingSecret: string;
  signedUrlTtlSeconds: number;
  now?: () => Date;
}

export interface LocalSignedObject {
  key: string;
  mimeType: string;
  sizeBytes: number;
  /** Sent as `Content-Disposition` when the URL was signed for a download. */
  contentDisposition?: string;
  stream: Readable;
}

/** A signed URL names one operation. A token with no `op` is a read. */
interface SignedPayload {
  key: string;
  exp: number;
  /** `Content-Disposition` signed with the URL, so a link can't be re-pointed at another name. */
  cd?: string;
  op?: "put";
  /** The length and type a PUT must carry, as on an S3 signature. */
  size?: number;
  mime?: string;
}

/** Local stand-in for a bucket lifecycle rule: temp files older than this are crash leftovers. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
const TEMP_DIR = ".tmp";

function ok<T>(value: T): ObjectStoreResult<T> {
  return { ok: true, value };
}

function err(code: ObjectStoreErrorCode, message: string): ObjectStoreResult<never> {
  return { ok: false, error: { code, message } };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function ioError(error: unknown, fallback: string): ObjectStoreResult<never> {
  return err("io_error", error instanceof Error ? error.message : fallback);
}

const SAFE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_:+=.,@-]*$/;

function isSafeKey(key: string): boolean {
  return SAFE_KEY_RE.test(key) && !key.split("/").some((part) => part === ".." || part === "");
}

function encodePayload(payload: SignedPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): SignedPayload | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SignedPayload>;
    if (typeof parsed.key !== "string" || typeof parsed.exp !== "number") return null;
    return {
      key: parsed.key,
      exp: parsed.exp,
      ...(typeof parsed.cd === "string" ? { cd: parsed.cd } : {}),
      ...(parsed.op === "put" && typeof parsed.size === "number" && typeof parsed.mime === "string"
        ? { op: "put" as const, size: parsed.size, mime: parsed.mime }
        : {}),
    };
  } catch {
    return null;
  }
}

export class LocalObjectStoreAdapter implements ObjectStorePort {
  private readonly rootDir: string;
  private readonly signedUrlBasePath: string;
  private readonly signingSecret: string;
  private readonly signedUrlTtlSeconds: number;
  private readonly now: () => Date;

  constructor(options: LocalObjectStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.signedUrlBasePath = options.signedUrlBasePath.replace(/\/+$/, "");
    this.signingSecret = options.signingSecret;
    this.signedUrlTtlSeconds = options.signedUrlTtlSeconds;
    this.now = options.now ?? (() => new Date());
    void this.clearStaleTemp();
  }

  async put(
    key: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<ObjectStoreResult<{ storageUrl: string }>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      await mkdir(path.dirname(target.value), { recursive: true });
      await writeFile(target.value, bytes);
      await writeFile(
        this.metadataPath(target.value),
        JSON.stringify(
          {
            key,
            mimeType,
            sizeBytes: bytes.byteLength,
            updatedAt: this.now().toISOString(),
          } satisfies LocalObjectMetadata,
          null,
          2,
        ),
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
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      if (options?.maxBytes !== undefined && (await stat(target.value)).size > options.maxBytes)
        return err("too_large", "Object is too large to read");
      const [bytes, metadata] = await Promise.all([
        readFile(target.value),
        readFile(this.metadataPath(target.value), "utf8"),
      ]);
      const parsed = JSON.parse(metadata) as LocalObjectMetadata;
      return ok({ bytes: new Uint8Array(bytes), mimeType: parsed.mimeType });
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object not found")
        : ioError(error, "Failed to read object");
    }
  }

  async getStream(key: string): Promise<ObjectStoreResult<ObjectStoreStreamOutput>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      const [size, metadata] = await Promise.all([
        stat(target.value),
        readFile(this.metadataPath(target.value), "utf8"),
      ]);
      const parsed = JSON.parse(metadata) as LocalObjectMetadata;
      return ok({
        stream: createReadStream(target.value),
        mimeType: parsed.mimeType,
        sizeBytes: Number(size.size),
      });
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object not found")
        : ioError(error, "Failed to read object");
    }
  }

  async copy(fromKey: string, toKey: string): Promise<ObjectStoreResult<ObjectStoreCopyOutput>> {
    const source = this.objectPath(fromKey);
    if (!source.ok) return source;
    const target = this.objectPath(toKey);
    if (!target.ok) return target;

    try {
      const metadata = JSON.parse(
        await readFile(this.metadataPath(source.value), "utf8"),
      ) as LocalObjectMetadata;
      const tempData = await this.tempPath();
      try {
        await copyFile(source.value, tempData);
        await this.commit(tempData, target.value, {
          ...metadata,
          key: toKey,
          updatedAt: this.now().toISOString(),
        });
      } catch (error) {
        await rm(tempData, { force: true });
        throw error;
      }
      return ok({
        storageUrl: createObjectStorageUrl(toKey),
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
      });
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object not found")
        : ioError(error, "Failed to copy object");
    }
  }

  async readHead(key: string, headBytes: number): Promise<ObjectStoreResult<ObjectStoreHead>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      const file = await open(target.value, "r");
      try {
        const { size } = await file.stat();
        const head = Buffer.alloc(Math.min(headBytes, size));
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        return ok({ head: new Uint8Array(head.subarray(0, bytesRead)), sizeBytes: size });
      } finally {
        await file.close();
      }
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object not found")
        : ioError(error, "Failed to read object");
    }
  }

  async signPut(
    key: string,
    options: ObjectStoreSignedPutOptions,
  ): Promise<ObjectStoreResult<ObjectStoreSignedPut>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    const exp = Math.floor(this.now().getTime() / 1000) + this.signedUrlTtlSeconds;
    const payload = encodePayload({
      key,
      exp,
      op: "put",
      size: options.sizeBytes,
      mime: options.mimeType,
    });
    return ok({
      url: `${this.signedUrlBasePath}/${payload}.${this.sign(payload)}`,
      headers: { "Content-Type": options.mimeType },
    });
  }

  /**
   * Stores the body of a PUT to a `signPut` URL. The body is destroyed on every outcome, so the
   * caller owes it nothing. A wrong length or type, an expired token or a token that is not a PUT
   * stores nothing; a right one replaces any object at the key, as an S3 PUT does.
   */
  async writeSignedToken(
    token: string,
    request: { body: Readable; contentLength: number | null; contentType: string | null },
  ): Promise<ObjectStoreResult<void>> {
    const refuse = (error: ObjectStoreResult<never>) => {
      request.body.destroy();
      return error;
    };
    const payload = this.verify(token);
    if (!payload.ok) return refuse(payload);
    const { key, op, size, mime } = payload.value;
    if (op !== "put" || size === undefined) return refuse(err("invalid_key", "Not a PUT URL"));
    if (request.contentLength !== size || request.contentType !== mime)
      return refuse(err("invalid_key", "The PUT's length or type is not the one signed"));
    const target = this.objectPath(key);
    if (!target.ok) return refuse(target);

    const tempData = await this.tempPath();
    try {
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          done(received > size ? new Error("body is longer than signed") : null, chunk);
        },
      });
      await pipeline(request.body, counter, createWriteStream(tempData));
      if (received !== size) throw new Error("body is shorter than signed");
      await this.commit(tempData, target.value, {
        key,
        mimeType: mime ?? "application/octet-stream",
        sizeBytes: size,
        updatedAt: this.now().toISOString(),
      });
      return ok(undefined);
    } catch (error) {
      request.body.destroy();
      await rm(tempData, { force: true });
      return ioError(error, "Failed to write object");
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
    const normalizedPrefix = prefix.replace(/\/+$/, "");
    if (!isSafeKey(normalizedPrefix) && normalizedPrefix !== "")
      return err("invalid_key", "Object key prefix is invalid");

    const limit = options?.limit ?? 1_000;
    const collected = await this.collectKeysUnderPrefix(normalizedPrefix);
    if (!collected.ok) return collected;
    const keys = collected.value;
    const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const page = keys.slice(startIndex, startIndex + limit);
    const entries = await Promise.all(
      page.map(async (key) => {
        const target = this.objectPath(key);
        if (!target.ok) return target;
        try {
          const [fileStat, metadata] = await Promise.all([
            stat(target.value),
            readFile(this.metadataPath(target.value), "utf8"),
          ]);
          const parsed = JSON.parse(metadata) as LocalObjectMetadata;
          return ok({ key, sizeBytes: Number(fileStat.size), mimeType: parsed.mimeType });
        } catch (error) {
          return isMissingFile(error)
            ? err("not_found", "Object changed while listing")
            : ioError(error, "Failed to list object");
        }
      }),
    );
    const nextIndex = startIndex + page.length;
    const listedEntries: Array<{ key: string; sizeBytes: number; mimeType?: string }> = [];
    for (const entry of entries) {
      if (!entry.ok) return entry;
      listedEntries.push(entry.value);
    }
    return ok({
      keys: listedEntries,
      ...(nextIndex < keys.length ? { cursor: String(nextIndex) } : {}),
    });
  }

  async getSignedUrl(
    key: string,
    options?: ObjectStoreSignedUrlOptions,
  ): Promise<ObjectStoreResult<string>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      await stat(target.value);
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object not found")
        : ioError(error, "Failed to stat object");
    }

    const exp = Math.floor(this.now().getTime() / 1000) + this.signedUrlTtlSeconds;
    const payload = encodePayload({
      key,
      exp,
      ...(options?.contentDisposition ? { cd: options.contentDisposition } : {}),
    });
    const signature = this.sign(payload);
    return ok(`${this.signedUrlBasePath}/${payload}.${signature}`);
  }

  async delete(key: string): Promise<ObjectStoreResult<void>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      await unlink(target.value).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return;
        throw error;
      });
      await unlink(this.metadataPath(target.value)).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return;
        throw error;
      });
      return ok(undefined);
    } catch (error) {
      return err("io_error", error instanceof Error ? error.message : "Failed to delete object");
    }
  }

  async readSignedToken(token: string): Promise<ObjectStoreResult<LocalSignedObject>> {
    const payload = this.verify(token);
    if (!payload.ok) return payload;
    if (payload.value.op) return err("invalid_key", "Signed URL is not a read URL");

    const target = this.objectPath(payload.value.key);
    if (!target.ok) return target;

    let metadata: LocalObjectMetadata;
    try {
      metadata = JSON.parse(
        await readFile(this.metadataPath(target.value), "utf8"),
      ) as LocalObjectMetadata;
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object metadata not found")
        : ioError(error, "Failed to read object metadata");
    }

    try {
      const size = await stat(target.value);
      return ok({
        key: payload.value.key,
        mimeType: metadata.mimeType,
        sizeBytes: Number(size.size),
        ...(payload.value.cd ? { contentDisposition: payload.value.cd } : {}),
        stream: createReadStream(target.value),
      });
    } catch (error) {
      return isMissingFile(error)
        ? err("not_found", "Object not found")
        : ioError(error, "Failed to stat object");
    }
  }

  signedUrlExpiresAt(): string {
    return new Date(this.now().getTime() + this.signedUrlTtlSeconds * 1000).toISOString();
  }

  private objectPath(key: string): ObjectStoreResult<string> {
    if (!isSafeKey(key)) return err("invalid_key", "Object key is invalid");

    const target = path.resolve(this.rootDir, key);
    if (!target.startsWith(`${this.rootDir}${path.sep}`)) {
      return err("invalid_key", "Object key escapes storage root");
    }
    return ok(target);
  }

  private async tempPath(): Promise<string> {
    const dir = path.join(this.rootDir, TEMP_DIR);
    await mkdir(dir, { recursive: true });
    return path.join(dir, `${crypto.randomUUID()}.part`);
  }

  /**
   * Moves a finished temp file to `target` with its metadata. The metadata is written to a temp
   * file first, so a failure to write it leaves an existing object as it was.
   */
  private async commit(
    tempData: string,
    target: string,
    metadata: LocalObjectMetadata,
  ): Promise<void> {
    const tempMetadata = `${tempData}.metadata`;
    try {
      await writeFile(tempMetadata, JSON.stringify(metadata, null, 2));
      await mkdir(path.dirname(target), { recursive: true });
      await rename(tempData, target);
      await rename(tempMetadata, this.metadataPath(target));
    } catch (error) {
      await rm(tempMetadata, { force: true });
      throw error;
    }
  }

  private async clearStaleTemp(): Promise<void> {
    const dir = path.join(this.rootDir, TEMP_DIR);
    const cutoff = this.now().getTime() - STALE_TEMP_MS;
    try {
      for (const entry of await readdir(dir)) {
        const file = path.join(dir, entry);
        if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
      }
    } catch {
      // Best effort and off the request path: a missing temp dir, or a file another process just
      // finished with, leaves nothing to clear, and a stale file costs only disk until next start.
    }
  }

  private metadataPath(objectPath: string): string {
    return `${objectPath}.metadata.json`;
  }

  private async collectKeysUnderPrefix(prefix: string): Promise<ObjectStoreResult<string[]>> {
    const keys: string[] = [];
    const walk = async (relativeDir: string): Promise<ObjectStoreResult<void>> => {
      const absoluteDir = relativeDir ? path.join(this.rootDir, relativeDir) : this.rootDir;
      let entries: string[];
      try {
        entries = await readdir(absoluteDir);
      } catch (error) {
        return isMissingFile(error) && relativeDir
          ? ok(undefined)
          : isMissingFile(error)
            ? ok(undefined)
            : ioError(error, "Failed to enumerate object store");
      }
      for (const entry of entries) {
        if (entry.endsWith(".metadata.json") || (!relativeDir && entry === TEMP_DIR)) continue;
        const relativePath = relativeDir ? path.join(relativeDir, entry) : entry;
        const absolutePath = path.join(absoluteDir, entry);
        let fileStat: Stats;
        try {
          fileStat = await stat(absolutePath);
        } catch (error) {
          return isMissingFile(error)
            ? err("not_found", "Object changed while listing")
            : ioError(error, "Failed to inspect object store entry");
        }
        const key = relativePath.split(path.sep).join("/");
        if (fileStat.isDirectory()) {
          const nested = await walk(relativePath);
          if (!nested.ok) return nested;
          continue;
        }
        if (key.startsWith(prefix)) keys.push(key);
      }
      return ok(undefined);
    };
    const result = await walk("");
    return result.ok ? ok(keys.sort((a, b) => a.localeCompare(b))) : result;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingSecret).update(payload).digest("base64url");
  }

  private verify(token: string): ObjectStoreResult<SignedPayload> {
    const [payloadText, signature, ...rest] = token.split(".");
    if (!payloadText || !signature || rest.length > 0)
      return err("invalid_key", "Signed URL token is malformed");

    const expected = this.sign(payloadText);
    const expectedBytes = Buffer.from(expected, "base64url");
    const actualBytes = Buffer.from(signature, "base64url");
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      return err("invalid_key", "Signed URL token signature is invalid");
    }

    const payload = decodePayload(payloadText);
    if (!payload) return err("invalid_key", "Signed URL token payload is invalid");
    if (!isSafeKey(payload.key)) return err("invalid_key", "Signed URL token key is invalid");
    if (payload.exp < Math.floor(this.now().getTime() / 1000)) {
      return err("not_found", "Signed URL has expired");
    }

    return ok(payload);
  }
}
