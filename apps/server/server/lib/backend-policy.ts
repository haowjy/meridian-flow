/**
 * Backend provider policy: one module owns local/live defaults for the provider
 * seams Meridian Flow actually keeps.
 *
 * Explicit per-service overrides win. Otherwise MERIDIAN_BACKENDS chooses local
 * or live defaults. Unset umbrella defaults to local so development and CI do
 * not accidentally require cloud services.
 */

export type BackendTier = "local" | "live";
export type ObjectStoreProvider = "local" | "s3";
export type EventProvider = "none" | "noop" | "local";

export type BackendEnv = {
  MERIDIAN_BACKENDS?: BackendTier;
  OBJECT_STORE_PROVIDER?: ObjectStoreProvider;
  EVENT_PROVIDER?: EventProvider;
};

export type ResolvedBackends = {
  backends: BackendTier;
  objectStore: ObjectStoreProvider;
  event: EventProvider;
};

export function resolveBackendTier(value: BackendTier | undefined): BackendTier {
  return value ?? "local";
}

/** Pick a provider: explicit per-service override wins; otherwise follow the umbrella tier. */
export function resolveProvider<T extends string>(args: {
  override: T | undefined;
  backends: BackendTier;
  local: T;
  live: T;
}): T {
  return args.override ?? (args.backends === "live" ? args.live : args.local);
}

/** Resolve subsystem providers from env in one place. */
export function resolveBackends(env: BackendEnv): ResolvedBackends {
  const backends = resolveBackendTier(env.MERIDIAN_BACKENDS);
  return {
    backends,
    objectStore: resolveProvider({
      override: env.OBJECT_STORE_PROVIDER,
      backends,
      local: "local",
      live: "s3",
    }),
    // Meridian Flow currently has process-local event fan-out plus durable DB
    // rows. Keep the event sink local in both tiers until a second provider is
    // implemented.
    event: resolveProvider({
      override: env.EVENT_PROVIDER,
      backends,
      local: "local",
      live: "local",
    }),
  };
}
