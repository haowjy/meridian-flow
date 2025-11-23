/**
 * Shared caching utilities for local-first architecture.
 *
 * Three caching patterns:
 * 1. Cache-first: Documents (local = source of truth, background refresh)
 * 2. Network-first: Chats/Projects (server = source of truth, cache fallback)
 * 3. Windowed: Messages (only cache recent N items)
 */
import type { Table } from 'dexie'
import { makeLogger } from '@/core/lib/logger'

const log = makeLogger('cache')

/**
 * Cache-first load pattern.
 *
 * Use for: Documents where local edits are source of truth
 *
 * Flow:
 * 1. Check IndexedDB cache
 * 2. If hit: Display immediately + optional background refresh
 * 3. If miss: Fetch from API + cache result
 */
// Removed legacy loadCacheFirst

/**
 * Network-first load pattern.
 *
 * Use for: Chats, Projects where server is source of truth
 *
 * Flow:
 * 1. Fetch from API (prefer fresh data)
 * 2. Update cache on success
 * 3. On network error: Fallback to cache if available
 */
// Removed legacy loadNetworkFirst

// Removed legacy loadNewestByUpdatedAt implementation; a wrapper exists below that

/**
 * Bulk cache update for lists.
 *
 * Use for: Document trees, chat lists, project lists
 */
export async function bulkCacheUpdate<T extends { id: string }>(
  table: Table<T, string>,
  items: T[],
  filterFn?: (item: T) => boolean
): Promise<void> {
  const toCache = filterFn ? items.filter(filterFn) : items

  if (toCache.length > 0) {
    await table.bulkPut(toCache)
    log.info(`bulk cached`, toCache.length, 'items')
  }
}

/**
 * Windowed cache update - only keeps most recent N items.
 *
 * Use for: Chat messages (prevent unbounded growth)
 *
 * Sorts by createdAt (newest first) and caches only the window size.
 * Adds lastAccessedAt for future eviction (not implemented yet).
 */
export async function windowedCacheUpdate<T extends { id: string; createdAt: Date }>(
  table: Table<T, string>,
  parentKey: string, // e.g., 'chat-123' for logging
  items: T[],
  windowSize: number = 100
): Promise<void> {
  // Sort by createdAt (newest first)
  const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  // Take only the most recent N
  const toCache = sorted.slice(0, windowSize)

  // Add timestamp for future eviction tracking
  const withTimestamp = toCache.map((item) => ({
    ...item,
    lastAccessedAt: new Date(),
  }))

  await table.bulkPut(withTimestamp)
  log.info(`windowed cache`, `${toCache.length}/${items.length}`, 'for', parentKey)
}

/**
 * Helper to check if cache entry should be considered stale.
 *
 * Use for: Optional cache invalidation logic
 * Currently not used - implement when auto-eviction is needed.
 */
export function isCacheStale(lastAccessedAt: Date, maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): boolean {
  return Date.now() - lastAccessedAt.getTime() > maxAgeMs
}

// =============================
// Policy-based cache loader (SOLID-friendly)
// =============================

export type LoadSource = 'server' | 'cache'

export type LoadResult<T> = {
  data: T
  source: LoadSource
  isFinal: boolean
}

export interface ICacheRepo<T> {
  get(): Promise<T | undefined>
  put(data: T): Promise<void>
}

export interface IRemoteRepo<T> {
  fetch(signal?: AbortSignal): Promise<T>
}

export type IComparer<T> = (a: T, b: T) => number

export interface LoadPolicyArgs<T> {
  cacheRepo: ICacheRepo<T>
  remoteRepo: IRemoteRepo<T>
  compare?: IComparer<T>
  onIntermediate?: (r: LoadResult<T>) => void
  signal?: AbortSignal
}

export interface LoadPolicy<T> {
  run(args: LoadPolicyArgs<T>): Promise<LoadResult<T>>
}

// Default comparer: compare updatedAt if present, else treat as equal
function defaultCompare<T>(a: T, b: T): number {
  const aWithUpdatedAt = a as { updatedAt?: Date } | undefined
  const bWithUpdatedAt = b as { updatedAt?: Date } | undefined

  if (aWithUpdatedAt?.updatedAt instanceof Date && bWithUpdatedAt?.updatedAt instanceof Date) {
    return aWithUpdatedAt.updatedAt.getTime() - bWithUpdatedAt.updatedAt.getTime()
  }
  return 0
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
  async run({ cacheRepo, remoteRepo, compare = defaultCompare, onIntermediate, signal }: LoadPolicyArgs<T>): Promise<LoadResult<T>> {
    const cachePromise = cacheRepo.get()
    const remotePromise = remoteRepo.fetch(signal)

    let cached: T | undefined

    try {
      cached = await cachePromise
      if (cached) {
        onIntermediate?.({ data: cached, source: 'cache', isFinal: false })
      }
    } catch {
      // cache read failure → ignore, rely on server
    }

    try {
      const server = await remotePromise

      if (!cached) {
        // No cache → server wins, update cache
        await cacheRepo.put(server)
        return { data: server, source: 'server', isFinal: true }
      }

      // Compare; local wins on tie (server must be strictly newer)
      const cmp = compare(cached, server)
      if (cmp < 0) {
        await cacheRepo.put(server)
        return { data: server, source: 'server', isFinal: true }
      }
      return { data: cached, source: 'cache', isFinal: true }
    } catch (err: unknown) {
      // Abort: if we emitted cache, use it; else rethrow
      if (err instanceof Error && err.name === 'AbortError') {
        if (cached) {
          return { data: cached, source: 'cache', isFinal: true }
        }
        throw err
      }
      // Network failure: fallback to cache if we have it
      if (cached) {
        return { data: cached, source: 'cache', isFinal: true }
      }
      throw err
    }
  }
}

/**
 * NetworkFirstPolicy
 * - Try server; on success, update cache and return
 * - On abort/network error: fallback to cache if present; else throw
 */
export class NetworkFirstPolicy<T> implements LoadPolicy<T> {
  async run({ cacheRepo, remoteRepo, onIntermediate, signal }: LoadPolicyArgs<T>): Promise<LoadResult<T>> {
    try {
      const data = await remoteRepo.fetch(signal)
      await cacheRepo.put(data)
      return { data, source: 'server', isFinal: true }
    } catch (err: unknown) {
      const cached = await cacheRepo.get().catch(() => undefined)
      if (cached) {
        onIntermediate?.({ data: cached, source: 'cache', isFinal: true })
        return { data: cached, source: 'cache', isFinal: true }
      }
      throw err
    }
  }
}

/**
 * StaleWhileRevalidatePolicy
 * - Emit cache immediately if present (via onIntermediate)
 * - Always attempt server
 * - Always update cache with server data (Server is source of truth)
 * - Return server data
 * - On abort/network error: return cache if available, else throw
 */
export class StaleWhileRevalidatePolicy<T> implements LoadPolicy<T> {
  async run({ cacheRepo, remoteRepo, onIntermediate, signal }: LoadPolicyArgs<T>): Promise<LoadResult<T>> {
    const cachePromise = cacheRepo.get()
    const remotePromise = remoteRepo.fetch(signal)

    let cached: T | undefined

    try {
      cached = await cachePromise
      if (cached) {
        onIntermediate?.({ data: cached, source: 'cache', isFinal: false })
      }
    } catch {
      // cache read failure → ignore, rely on server
    }

    try {
      const server = await remotePromise
      await cacheRepo.put(server)
      return { data: server, source: 'server', isFinal: true }
    } catch (err: unknown) {
      // Abort: if we emitted cache, use it; else rethrow
      if (err instanceof Error && err.name === 'AbortError') {
        if (cached) {
          return { data: cached, source: 'cache', isFinal: true }
        }
        throw err
      }
      // Network failure: fallback to cache if we have it
      if (cached) {
        return { data: cached, source: 'cache', isFinal: true }
      }
      throw err
    }
  }
}

export async function loadWithPolicy<T>(policy: LoadPolicy<T>, args: LoadPolicyArgs<T>): Promise<LoadResult<T>> {
  return policy.run(args)
}

// Backward-compatible wrappers (migration path)

export async function loadNewestByUpdatedAt<T extends { id: string; updatedAt: Date }>(options: {
  cacheKey: string
  cacheLookup: () => Promise<T | undefined>
  apiFetch: (signal?: AbortSignal) => Promise<T>
  cacheUpdate: (data: T) => Promise<void>
  signal?: AbortSignal
}): Promise<T> {
  const result = await loadWithPolicy<T>(
    new ReconcileNewestPolicy<T>(),
    {
      cacheRepo: { get: options.cacheLookup, put: options.cacheUpdate },
      remoteRepo: { fetch: options.apiFetch },
      signal: options.signal,
    }
  )
  return result.data
}

// Re-implement loadNetworkFirst wrapper using NetworkFirstPolicy (non-breaking)
// Note: Keep signature to avoid touching callers during migration
export async function loadNetworkFirstPolicy<T>(options: {
  cacheKey: string
  cacheLookup: () => Promise<T | undefined>
  apiFetch: (signal?: AbortSignal) => Promise<T>
  cacheUpdate: (data: T) => Promise<void>
  signal?: AbortSignal
}): Promise<T> {
  const result = await loadWithPolicy<T>(
    new NetworkFirstPolicy<T>(),
    {
      cacheRepo: { get: options.cacheLookup, put: options.cacheUpdate },
      remoteRepo: { fetch: options.apiFetch },
      signal: options.signal,
    }
  )
  return result.data
}
