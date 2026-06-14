import { tmpdir } from "node:os";
import path from "node:path";
import {
  LocalObjectStoreAdapter,
  type ObjectStorePort,
  S3ObjectStoreAdapter,
} from "../domains/storage/index.js";

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createObjectStoreFromEnv(): {
  objectStore: ObjectStorePort;
  localObjectStore: LocalObjectStoreAdapter | null;
} {
  const provider = process.env.OBJECT_STORE_PROVIDER ?? "local";
  if (provider === "local") {
    const localObjectStore = new LocalObjectStoreAdapter({
      rootDir: process.env.LOCAL_OBJECT_STORE_DIR ?? path.join(tmpdir(), "meridian-object-store"),
      signedUrlBasePath:
        process.env.LOCAL_OBJECT_STORE_SIGNED_URL_BASE_PATH ?? "/api/object-store/local",
      signingSecret: process.env.OBJECT_STORE_SIGNING_SECRET ?? "dev-object-store-secret",
      signedUrlTtlSeconds: intEnv("OBJECT_STORE_SIGNED_URL_TTL_SECONDS", 900),
    });
    return { objectStore: localObjectStore, localObjectStore };
  }
  if (provider === "s3") {
    const objectStore = new S3ObjectStoreAdapter({
      bucket: process.env.S3_BUCKET ?? "meridian-dev",
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      forcePathStyle: boolEnv("S3_FORCE_PATH_STYLE", true),
      signedUrlTtlSeconds: intEnv("OBJECT_STORE_SIGNED_URL_TTL_SECONDS", 900),
      createBucketIfMissing: boolEnv("S3_CREATE_BUCKET_IF_MISSING"),
    });
    return { objectStore, localObjectStore: null };
  }
  throw new Error(`Unsupported OBJECT_STORE_PROVIDER: ${provider}`);
}
