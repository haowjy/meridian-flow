/**
 * Shared caching utilities for local-first architecture.
 *
 * Three caching patterns:
 * 1. Cache-first: Documents (local = source of truth, background refresh)
 * 2. Network-first: Chats/Projects (server = source of truth, cache fallback)
 * 3. Windowed: Messages (only cache recent N items)
 */

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
export async function loadCacheFirst<T extends { id: string; updatedAt: Date }>(options: {
  cacheKey: string
  cacheLookup: () => Promise<T | undefined>
  apiFetch: (signal?: AbortSignal) => Promise<T>
  cacheUpdate: (data: T) => Promise<void>
  shouldBackgroundRefresh?: () => boolean
  signal?: AbortSignal
}): Promise<T> {
  const { cacheKey, cacheLookup, apiFetch, cacheUpdate, shouldBackgroundRefresh, signal } = options

  // Step 1: Check cache
  const cached = await cacheLookup()

  if (cached) {
    console.log(`[Cache] Hit for ${cacheKey}`)

    // Background refresh (if allowed)
    if (shouldBackgroundRefresh?.() !== false) {
      // Fire and forget - don't await
      apiFetch(signal)
        .then(async (fresh) => {
          // Only update if server version is newer
          if (fresh.updatedAt > cached.updatedAt) {
            await cacheUpdate(fresh)
            console.log(`[Cache] Background refresh updated ${cacheKey}`)
          }
        })
        .catch((error) => {
          // Silent failure - cached data is still valid
          if (error instanceof Error && error.name !== 'AbortError') {
            console.error(`[Cache] Background refresh failed for ${cacheKey}:`, error)
          }
        })
    }

    return cached
  }

  // Step 2: Cache miss - fetch from API
  console.log(`[Cache] Miss for ${cacheKey}`)
  const fresh = await apiFetch(signal)
  await cacheUpdate(fresh)

  return fresh
}

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
export async function loadNetworkFirst<T>(options: {
  cacheKey: string
  cacheLookup: () => Promise<T | undefined>
  apiFetch: (signal?: AbortSignal) => Promise<T>
  cacheUpdate: (data: T) => Promise<void>
  signal?: AbortSignal
}): Promise<T> {
  const { cacheKey, cacheLookup, apiFetch, cacheUpdate, signal } = options

  try {
    // Step 1: Fetch from API (prefer fresh data)
    console.log(`[Cache] Fetching ${cacheKey} (network-first)`)
    const fresh = await apiFetch(signal)

    // Step 2: Update cache
    await cacheUpdate(fresh)

    return fresh
  } catch (error) {
    // Don't fallback for aborts (user cancelled)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }

    // Step 3: On error, try cache fallback
    console.warn(`[Cache] Network failed for ${cacheKey}, checking cache`)
    const cached = await cacheLookup()

    if (cached) {
      console.log(`[Cache] Using cached ${cacheKey}`)
      return cached
    }

    // No cache available - throw original error
    throw error
  }
}

/**
 * Network + Cache reconciliation by `updatedAt`.
 *
 * Always attempt a network fetch, in parallel with a cache lookup.
 * - If network succeeds: choose the newer of (server, cache) by `updatedAt`.
 *   - If server wins, update cache.
 *   - If cache wins, return cache as the authoritative version for now.
 * - If network fails (non-abort): fallback to cache if available, else rethrow.
 *
 * Use for: Documents where user may switch devices; prefer the newest version
 * regardless of source. Avoids "local always wins" while still enabling offline.
 */
export async function loadNewestByUpdatedAt<T extends { id: string; updatedAt: Date }>(options: {
  cacheKey: string
  cacheLookup: () => Promise<T | undefined>
  apiFetch: (signal?: AbortSignal) => Promise<T>
  cacheUpdate: (data: T) => Promise<void>
  signal?: AbortSignal
}): Promise<T> {
  const { cacheKey, cacheLookup, apiFetch, cacheUpdate, signal } = options

  console.log(`[Cache] Reconciling newest for ${cacheKey}`)

  const [cacheResult, apiResult] = await Promise.allSettled([
    cacheLookup(),
    apiFetch(signal),
  ])

  const cached: T | undefined = cacheResult.status === 'fulfilled' ? cacheResult.value : undefined
  const apiError = apiResult.status === 'rejected' ? apiResult.reason : null
  const server: T | undefined = apiResult.status === 'fulfilled' ? apiResult.value : undefined

  // If server succeeded
  if (server) {
    if (!cached) {
      // No cache → use server and cache it
      await cacheUpdate(server)
      return server
    }

    // Both present → pick the newer
    if (server.updatedAt >= cached.updatedAt) {
      await cacheUpdate(server)
      return server
    } else {
      return cached
    }
  }

  // Server failed
  if (apiError instanceof Error && apiError.name === 'AbortError') {
    // Prefer cached data if available on abort (e.g., dependency changed)
    if (cached) {
      console.warn(`[Cache] Network aborted for ${cacheKey}; using cache`)
      return cached
    }
    // No cache to fall back to; propagate
    throw apiError
  }

  if (cached) {
    console.warn(`[Cache] Network failed for ${cacheKey}; using cache`)
    return cached
  }

  // No cache either → rethrow the original error
  if (apiError instanceof Error) throw apiError
  throw new Error(`Failed to load ${cacheKey}`)
}

/**
 * Bulk cache update for lists.
 *
 * Use for: Document trees, chat lists, project lists
 */
export async function bulkCacheUpdate<T extends { id: string }>(
  table: any, // Dexie table
  items: T[],
  filterFn?: (item: T) => boolean
): Promise<void> {
  const toCache = filterFn ? items.filter(filterFn) : items

  if (toCache.length > 0) {
    await table.bulkPut(toCache)
    console.log(`[Cache] Bulk cached ${toCache.length} items to ${table.name}`)
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
  table: any, // Dexie table
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
  console.log(`[Cache] Windowed cache: ${toCache.length}/${items.length} items for ${parentKey}`)
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
