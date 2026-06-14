// @ts-nocheck
/**
 * Local-filesystem implementation of the object-store port: stores objects under
 * a base dir and mints HMAC-signed local read tokens for signed URLs. Owns the
 * on-disk layout and token signing; depends inward on the port and URL helper.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { createObjectStorageUrl } from "../../object-storage-url.js";
import type {
  ObjectStoreErrorCode,
  ObjectStorePort,
  ObjectStoreResult,
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
  stream: Readable;
}

interface SignedPayload {
  key: string;
  exp: number;
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

function encodePayload(payload: SignedPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): SignedPayload | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SignedPayload>;
    if (typeof parsed.key !== "string" || typeof parsed.exp !== "number") return null;
    return { key: parsed.key, exp: parsed.exp };
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

  async get(key: string): Promise<ObjectStoreResult<{ bytes: Uint8Array; mimeType: string }>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      const [bytes, metadata] = await Promise.all([
        readFile(target.value),
        readFile(this.metadataPath(target.value), "utf8"),
      ]);
      const parsed = JSON.parse(metadata) as LocalObjectMetadata;
      return ok({ bytes: new Uint8Array(bytes), mimeType: parsed.mimeType });
    } catch {
      return err("not_found", "Object not found");
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
    const keys = await this.collectKeysUnderPrefix(normalizedPrefix);
    const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const page = keys.slice(startIndex, startIndex + limit);
    const entries = await Promise.all(
      page.map(async (key) => {
        const target = this.objectPath(key);
        if (!target.ok) return { key, sizeBytes: 0 };
        try {
          const [fileStat, metadata] = await Promise.all([
            stat(target.value),
            readFile(this.metadataPath(target.value), "utf8"),
          ]);
          const parsed = JSON.parse(metadata) as LocalObjectMetadata;
          return { key, sizeBytes: Number(fileStat.size), mimeType: parsed.mimeType };
        } catch {
          return { key, sizeBytes: 0 };
        }
      }),
    );
    const nextIndex = startIndex + page.length;
    return ok({
      keys: entries,
      ...(nextIndex < keys.length ? { cursor: String(nextIndex) } : {}),
    });
  }

  async getSignedUrl(key: string): Promise<ObjectStoreResult<string>> {
    const target = this.objectPath(key);
    if (!target.ok) return target;

    try {
      await stat(target.value);
    } catch {
      return err("not_found", "Object not found");
    }

    const exp = Math.floor(this.now().getTime() / 1000) + this.signedUrlTtlSeconds;
    const payload = encodePayload({ key, exp });
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

    const target = this.objectPath(payload.value.key);
    if (!target.ok) return target;

    let metadata: LocalObjectMetadata;
    try {
      metadata = JSON.parse(
        await readFile(this.metadataPath(target.value), "utf8"),
      ) as LocalObjectMetadata;
    } catch {
      return err("not_found", "Object metadata not found");
    }

    try {
      const size = await stat(target.value);
      return ok({
        key: payload.value.key,
        mimeType: metadata.mimeType,
        sizeBytes: Number(size.size),
        stream: createReadStream(target.value),
      });
    } catch {
      return err("not_found", "Object not found");
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

  private metadataPath(objectPath: string): string {
    return `${objectPath}.metadata.json`;
  }

  private async collectKeysUnderPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (relativeDir: string): Promise<void> => {
      const absoluteDir = relativeDir ? path.join(this.rootDir, relativeDir) : this.rootDir;
      let entries: string[];
      try {
        entries = await readdir(absoluteDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.endsWith(".metadata.json")) continue;
        const relativePath = relativeDir ? path.join(relativeDir, entry) : entry;
        const absolutePath = path.join(absoluteDir, entry);
        const fileStat = await stat(absolutePath);
        const key = relativePath.split(path.sep).join("/");
        if (fileStat.isDirectory()) {
          await walk(relativePath);
          continue;
        }
        if (key.startsWith(prefix)) keys.push(key);
      }
    };
    await walk("");
    return keys.sort((a, b) => a.localeCompare(b));
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
