export type ObjectStoreProvider = "local" | "s3";

type Env = Readonly<Record<string, string | undefined>>;

export type ObjectStoreConfig =
  | { provider: "local" }
  | {
      provider: "s3";
      bucket: string;
      region: string;
      endpoint: string | undefined;
      publicEndpoint: string | undefined;
      forcePathStyle: boolean;
    };

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

export function objectStoreReadOrigins(config: ObjectStoreConfig): string[] {
  if (config.provider !== "s3") return [];
  const signed = config.publicEndpoint || config.endpoint;
  const origin = new URL(signed || `https://s3.${config.region}.amazonaws.com`);
  return config.forcePathStyle
    ? [origin.origin]
    : [origin.origin, `${origin.protocol}//*.${origin.host}`];
}
