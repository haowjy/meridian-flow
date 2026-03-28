/**
 * SessionPool — warm-session manager for document lifecycle.
 *
 * Creates sessions on demand, supports preload/prefetch, handles idle
 * release with generation guards, evicts the oldest idle session when
 * the warm budget is exceeded, and makes invalidation/recovery flows
 * possible.
 *
 * Key invariants:
 *   - Generation guard prevents stale idle timers from destroying
 *     re-borrowed sessions (classic race: Surface A releases, timer
 *     starts, Surface B borrows before timer fires -> timer is a no-op)
 *   - Only DETACHED sessions (attachedViewCount === 0) are evictable
 *   - Warm budget caps the number of detached sessions, not total
 *   - Invalidated sessions stay in the pool so UI can show recovery options
 *   - subscribe() is useSyncExternalStore-compatible
 */

import { DocSession, type DocSessionConfig } from "./doc-session"
import type { DocumentWsProviderFactory, FrozenReason } from "./types"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionPoolConfig {
  /** How long a detached session stays warm before eviction (default 5 min). */
  idleMs?: number
  /** Maximum number of warm (detached) sessions to keep alive (default 10). */
  warmBudget?: number
  /** User info for awareness in all sessions. */
  user: { userId: string; userName: string }
  /** Optional WS provider factory — null until Phase 4. */
  wsFactory?: DocumentWsProviderFactory
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PoolEntry {
  session: DocSession
  idleTimer: ReturnType<typeof setTimeout> | null
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_WARM_BUDGET = 10

// ---------------------------------------------------------------------------
// SessionPool
// ---------------------------------------------------------------------------

export class SessionPool {
  private readonly sessions = new Map<string, PoolEntry>()
  private readonly inflightCreations = new Map<string, Promise<DocSession>>()
  private readonly inflightDestroys = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private readonly idleMs: number
  private readonly warmBudget: number
  private readonly userId: string
  private readonly userName: string
  private readonly wsFactory?: DocumentWsProviderFactory
  private destroyed = false

  constructor(config: SessionPoolConfig) {
    this.idleMs = config.idleMs ?? DEFAULT_IDLE_MS
    this.warmBudget = config.warmBudget ?? DEFAULT_WARM_BUDGET
    this.userId = config.user.userId
    this.userName = config.user.userName
    this.wsFactory = config.wsFactory
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get or create a session for a document.
   * If the session exists (warm), return it. If not, create from scratch (cold open).
   * Increments the session's generation counter.
   * If warm budget is exceeded after creation, evict the oldest idle session.
   */
  async ensureSession(id: string): Promise<DocSession> {
    this.assertNotDestroyed()

    // 1. Already warm — re-borrow
    const existing = this.sessions.get(id)
    if (existing) {
      existing.session.generation++
      this.notify()
      return existing.session
    }

    // 2. Destroy in progress — wait for it to finish, then create fresh
    const inflightDestroy = this.inflightDestroys.get(id)
    if (inflightDestroy) {
      await inflightDestroy
      // Re-check destroyed after await — pool may have shut down while we waited
      this.assertNotDestroyed()
    }

    // Re-check after awaiting destroy — another caller may have created it
    const existingAfterDestroy = this.sessions.get(id)
    if (existingAfterDestroy) {
      existingAfterDestroy.session.generation++
      this.notify()
      return existingAfterDestroy.session
    }

    // 3. Creation already in progress — deduplicate
    const inflightCreate = this.inflightCreations.get(id)
    if (inflightCreate) {
      return inflightCreate
    }

    // 4. Cold open — start creation and store promise for dedup
    const createPromise = this.createSession(id)
    this.inflightCreations.set(id, createPromise)

    try {
      return await createPromise
    } finally {
      this.inflightCreations.delete(id)
    }
  }

  /**
   * Warm a session without creating a view — for preload/prefetch.
   * Same as ensureSession() but doesn't imply a view will be attached.
   * Counts against warm budget. Increments generation.
   */
  async preload(id: string): Promise<DocSession> {
    // Semantically identical to ensureSession for the pool layer.
    // The distinction matters at the ViewController level (Phase 3).
    return this.ensureSession(id)
  }

  /**
   * Release a session — mark it as detached (no view attached).
   * Sets attachedViewCount to 0, records lastDetachedAt, starts idle timer.
   * The idle timer captures current generation; only fires if generation unchanged.
   */
  releaseSession(id: string): void {
    this.assertNotDestroyed()

    const entry = this.sessions.get(id)
    if (!entry) return

    entry.session.attachedViewCount = 0
    entry.session.lastDetachedAt = Date.now()

    this.startIdleTimer(id, entry)
    this.notify()
  }

  /**
   * Freeze a session for document deletion or access revocation.
   * The session stays in the pool (for UI to show recovery options) but
   * rejects further edits. Increments generation to cancel any pending idle timer.
   */
  async invalidateSession(id: string, reason: FrozenReason): Promise<void> {
    this.assertNotDestroyed()

    const entry = this.sessions.get(id)
    if (!entry) return

    entry.session.freeze(reason)
    // Increment generation to cancel any pending idle timer —
    // the stale timer will see a different generation and no-op.
    entry.session.generation++
    this.notify()
  }

  /** Get a session if it exists in the pool. Returns null if not warm. */
  getSession(id: string): DocSession | null {
    return this.sessions.get(id)?.session ?? null
  }

  /** Get all active session IDs. */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys())
  }

  /**
   * Subscribe to pool state changes (sessions added/removed/invalidated).
   * Compatible with useSyncExternalStore.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Destroy all sessions and clean up timers. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true

    // Cancel all idle timers first to prevent races during teardown
    for (const entry of this.sessions.values()) {
      if (entry.idleTimer !== null) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = null
      }
    }

    // Wait for any in-flight creations/destroys to finish so we don't
    // miss sessions that are being initialized or torn down.
    const inflightPromises: Promise<unknown>[] = [
      ...this.inflightCreations.values(),
      ...this.inflightDestroys.values(),
    ]
    await Promise.allSettled(inflightPromises)

    // Destroy all sessions in parallel — use allSettled so one failure
    // doesn't prevent cleanup of the rest
    const destroyPromises: Promise<void>[] = []
    for (const entry of this.sessions.values()) {
      destroyPromises.push(entry.session.destroy())
    }

    try {
      await Promise.allSettled(destroyPromises)
    } finally {
      this.sessions.clear()
      this.inflightCreations.clear()
      this.inflightDestroys.clear()
      this.listeners.clear()
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Create a new session, initialize it, enforce warm budget. */
  private async createSession(id: string): Promise<DocSession> {
    const config: DocSessionConfig = {
      documentId: id,
      userId: this.userId,
      userName: this.userName,
      wsProviderFactory: this.wsFactory,
    }

    const session = new DocSession(config)

    // Initialize (IDB sync + optional WS connect) BEFORE adding to pool.
    // If initialize() fails or pool is destroyed during init, the session
    // never enters the pool.
    try {
      await session.initialize()
    } catch (err) {
      await session.destroy()
      throw err
    }

    // Pool may have been destroyed while we were initializing.
    // Clean up and throw rather than inserting into a dead pool.
    if (this.destroyed) {
      await session.destroy()
      throw new Error("SessionPool has been destroyed")
    }

    const entry: PoolEntry = { session, idleTimer: null }
    this.sessions.set(id, entry)

    // Enforce warm budget — evict oldest detached session if over budget.
    // Only evict DETACHED sessions (attachedViewCount === 0).
    this.enforceWarmBudget()

    this.notify()
    return session
  }

  /**
   * Start an idle timer for a released session.
   * Captures the current generation as a stale guard — when the timer
   * fires, it only destroys the session if generation hasn't changed
   * (meaning nobody re-borrowed, preloaded, or invalidated it).
   */
  private startIdleTimer(id: string, entry: PoolEntry): void {
    // Cancel any existing timer for this session
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }

    const capturedGeneration = entry.session.generation

    entry.idleTimer = setTimeout(() => {
      // Generation guard: only destroy if generation unchanged
      if (entry.session.generation !== capturedGeneration) return
      // Double-check still detached
      if (entry.session.attachedViewCount !== 0) return
      // Still in the pool (could have been destroyed by budget eviction)
      if (!this.sessions.has(id)) return

      this.destroySession(id).catch(() => { /* session already removed from map */ })
    }, this.idleMs)
  }

  /**
   * Enforce the warm budget by evicting the oldest detached session.
   * Only evicts sessions with attachedViewCount === 0.
   */
  private enforceWarmBudget(): void {
    const detached = this.getDetachedEntries()
    if (detached.length <= this.warmBudget) return

    // Sort by lastDetachedAt ascending — oldest first.
    // Sessions that were never detached (lastDetachedAt === null) are
    // treated as "just created" and sorted last so they aren't evicted
    // before sessions that have actually been idle.
    // Explicit equality check avoids NaN from Infinity - Infinity.
    detached.sort((a, b) => {
      const aTime = a.session.lastDetachedAt ?? Infinity
      const bTime = b.session.lastDetachedAt ?? Infinity
      if (aTime === bTime) return 0
      return aTime - bTime
    })

    // Evict oldest detached sessions until we're within budget
    const excess = detached.length - this.warmBudget
    for (let i = 0; i < excess; i++) {
      const victim = detached[i]
      this.destroySession(victim.session.id).catch(() => { /* session already removed from map */ })
    }
  }

  /** Get all pool entries with no attached view, excluding frozen sessions. */
  private getDetachedEntries(): { session: DocSession; entry: PoolEntry }[] {
    const result: { session: DocSession; entry: PoolEntry }[] = []
    for (const [, entry] of this.sessions) {
      if (entry.session.attachedViewCount === 0 && !entry.session.isFrozen) {
        result.push({ session: entry.session, entry })
      }
    }
    return result
  }

  /** Destroy a single session: cancel timer, destroy session, remove from pool. */
  private async destroySession(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (!entry) return

    // Cancel idle timer
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }

    // Remove from pool synchronously to prevent re-borrow of dying session
    this.sessions.delete(id)

    // Track the in-flight destroy so ensureSession can await it
    const destroyPromise = entry.session.destroy()
    this.inflightDestroys.set(id, destroyPromise)

    try {
      await destroyPromise
    } finally {
      this.inflightDestroys.delete(id)
    }

    this.notify()
  }

  /** Notify all subscribers of a pool state change. */
  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** Guard: throw if pool has been destroyed. */
  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }
  }
}
