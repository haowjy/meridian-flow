/**
 * How the object store is configured from the environment, read once for every service that
 * needs it: the server builds its store from this, and the app's content security policy
 * lists the origins the store's signed read URLs point at. Two readings could disagree about
 * where a signed URL goes, and the browser would then block every uploaded picture.
 */

export type ObjectStoreProvider = "local" | "s3";

type Env = Readonly<Record<string, string | undefined>>;

export type ObjectStoreConfig =
  | { provider: "local" }
  | {
      provider: "s3";
      bucket: string;
      region: string;
      /** Custom endpoint for S3-compatible stores (MinIO, R2). */
      endpoint: string | undefined;
      /** The endpoint signed read URLs use, when the browser must reach a different one. */
      publicEndpoint: string | undefined;
      /** Path-style addressing; otherwise the bucket is a subdomain of the host. */
      forcePathStyle: boolean;
    };

/** The provider named by `OBJECT_STORE_PROVIDER`, else by the `MERIDIAN_BACKENDS` tier. */
export function resolveObjectStoreProvider(env: Env): ObjectStoreProvider {
  const named = env.OBJECT_STORE_PROVIDER as ObjectStoreProvider | undefined;
  return named ?? (env.MERIDIAN_BACKENDS === "live" ? "s3" : "local");
}

export function envFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function objectStoreConfig(env: Env): ObjectStoreConfig {
  const provider = resolveObjectStoreProvider(env);
  if (provider === "local") return { provider };
  if (provider !== "s3") throw new Error(`Unsupported OBJECT_STORE_PROVIDER: ${String(provider)}`);
  return {
    provider: "s3",
    bucket: env.S3_BUCKET ?? "meridian-dev",
    region: env.S3_REGION ?? "us-east-1",
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    forcePathStyle: envFlag(env.S3_FORCE_PATH_STYLE, true),
  };
}

/**
 * The origins a browser draws signed read URLs from: none for the local store (same-origin
 * paths), the signing endpoint for path style, and its bucket subdomains for virtual-hosted
 * style.
 */
export function objectStoreReadOrigins(config: ObjectStoreConfig): string[] {
  if (config.provider !== "s3") return [];
  const signed = config.publicEndpoint || config.endpoint;
  const origin = new URL(signed || `https://s3.${config.region}.amazonaws.com`);
  return config.forcePathStyle
    ? [origin.origin]
    : [origin.origin, `${origin.protocol}//*.${origin.host}`];
}
