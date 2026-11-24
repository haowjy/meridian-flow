import {
  type ObjectStoreProvider,
  resolveObjectStoreProvider,
} from "@meridian/contracts/object-store-env";

export type { ObjectStoreProvider };

export type BackendTier = "local" | "live";
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

export function resolveBackends(env: BackendEnv): ResolvedBackends {
  const backends = env.MERIDIAN_BACKENDS ?? "local";
  return {
    backends,
    objectStore: resolveObjectStoreProvider(env),
    event: env.EVENT_PROVIDER ?? "local",
  };
}
