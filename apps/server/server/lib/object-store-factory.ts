import { tmpdir } from "node:os";
import path from "node:path";
import { envFlag, objectStoreConfig } from "@meridian/contracts/object-store-env";
import {
  LocalObjectStoreAdapter,
  type ObjectStorePort,
  S3ObjectStoreAdapter,
} from "../domains/storage/index.js";

function intEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createObjectStoreFromEnv(): {
  objectStore: ObjectStorePort;
  localObjectStore: LocalObjectStoreAdapter | null;
} {
  // The provider and the S3 addressing come from the shared reading the app's content security policy
  // also uses: two readings would let a deployment pass the startup guards and still build the wrong store,
  // or sign URLs the browser then blocks.
  const config = objectStoreConfig(process.env);
  if (config.provider === "local") {
    const localObjectStore = new LocalObjectStoreAdapter({
      rootDir: process.env.LOCAL_OBJECT_STORE_DIR ?? path.join(tmpdir(), "meridian-object-store"),
      signedUrlBasePath:
        process.env.LOCAL_OBJECT_STORE_SIGNED_URL_BASE_PATH ?? "/api/object-store/local",
      signingSecret: process.env.OBJECT_STORE_SIGNING_SECRET ?? "dev-object-store-secret",
      signedUrlTtlSeconds: intEnv("OBJECT_STORE_SIGNED_URL_TTL_SECONDS", 900),
    });
    return { objectStore: localObjectStore, localObjectStore };
  }
  const objectStore = new S3ObjectStoreAdapter({
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    publicEndpoint: config.publicEndpoint,
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
    forcePathStyle: config.forcePathStyle,
    signedUrlTtlSeconds: intEnv("OBJECT_STORE_SIGNED_URL_TTL_SECONDS", 900),
    createBucketIfMissing: envFlag(process.env.S3_CREATE_BUCKET_IF_MISSING),
  });
  return { objectStore, localObjectStore: null };
}
