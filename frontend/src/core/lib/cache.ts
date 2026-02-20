/**
 * Shared caching utilities for local-first architecture.
 *
 * Policy-based cache loader (SOLID-friendly).
 */

export type LoadSource = "server" | "cache";

export type LoadResult<T> = {
  data: T;
  source: LoadSource;
  isFinal: boolean;
};

export interface ICacheRepo<T> {
  get(): Promise<T | undefined>;
  put(data: T): Promise<void>;
}

export interface IRemoteRepo<T> {
  fetch(signal?: AbortSignal): Promise<T>;
}

export type IComparer<T> = (a: T, b: T) => number;

export interface LoadPolicyArgs<T> {
  cacheRepo: ICacheRepo<T>;
  remoteRepo: IRemoteRepo<T>;
  compare?: IComparer<T>;
  onIntermediate?: (r: LoadResult<T>) => void;
  signal?: AbortSignal;
}

export interface LoadPolicy<T> {
  run(args: LoadPolicyArgs<T>): Promise<LoadResult<T>>;
}

// Helper to safely get timestamp from Date or ISO string
// IndexedDB may serialize Date objects to strings, so we need to handle both
// Returns NaN for missing/invalid timestamps (not 0/epoch) to distinguish "unknown" from "very old"
function getTimestamp(value: Date | string | undefined): number {
  if (!value) return NaN; // Missing = unknown, not epoch
  if (value instanceof Date) return value.getTime();
  // Handle ISO string (e.g., from IndexedDB serialization)
  const parsed = new Date(value);
  return parsed.getTime(); // Returns NaN if invalid
}

// Default comparer: compare updatedAt if present, else treat as equal (local wins on tie)
// Handles both Date objects and ISO strings (from IndexedDB serialization)
// When timestamps are missing (NaN), returns 0 so local wins by tie-breaker
function defaultCompare<T>(a: T, b: T): number {
  const aWithUpdatedAt = a as { updatedAt?: Date | string } | undefined;
  const bWithUpdatedAt = b as { updatedAt?: Date | string } | undefined;

  const aTime = getTimestamp(aWithUpdatedAt?.updatedAt);
  const bTime = getTimestamp(bWithUpdatedAt?.updatedAt);

  // If either timestamp is missing (NaN), treat as equal
  // Local wins on tie in ReconcileNewestPolicy (server must be strictly newer)
  if (isNaN(aTime) || isNaN(bTime)) return 0;

  return aTime - bTime;
}

/**
 * ReconcileNewestPolicy
 * - Emit cache immediately if present (via onIntermediate)
 * - Always attempt server
 * - Choose newer by compare (local wins on tie)
 * - Update cache when server wins
 * - On abort/network error: return cache if available, else throw
 */
export class ReconcileNewestPolicy<T> implements LoadPolicy<T> {
  async run({
    cacheRepo,
    remoteRepo,
    compare = defaultCompare,
    onIntermediate,
    signal,
  }: LoadPolicyArgs<T>): Promise<LoadResult<T>> {
    const cachePromise = cacheRepo.get();
    const remotePromise = remoteRepo.fetch(signal);

    let cached: T | undefined;

    try {
      cached = await cachePromise;
      if (cached) {
        onIntermediate?.({ data: cached, source: "cache", isFinal: false });
      }
    } catch {
      // cache read failure -> ignore, rely on server
    }

    try {
      const server = await remotePromise;

      if (!cached) {
        // No cache -> server wins, update cache
        await cacheRepo.put(server);
        return { data: server, source: "server", isFinal: true };
      }

      // Compare; local wins on tie (server must be strictly newer)
      const cmp = compare(cached, server);
      if (cmp < 0) {
        await cacheRepo.put(server);
        return { data: server, source: "server", isFinal: true };
      }
      return { data: cached, source: "cache", isFinal: true };
    } catch (err: unknown) {
      // Abort: if we emitted cache, use it; else rethrow
      if (err instanceof Error && err.name === "AbortError") {
        if (cached) {
          return { data: cached, source: "cache", isFinal: true };
        }
        throw err;
      }
      // Network failure: fallback to cache if we have it
      if (cached) {
        return { data: cached, source: "cache", isFinal: true };
      }
      throw err;
    }
  }
}

export async function loadWithPolicy<T>(
  policy: LoadPolicy<T>,
  args: LoadPolicyArgs<T>,
): Promise<LoadResult<T>> {
  return policy.run(args);
}
