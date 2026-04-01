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

import type { DocStreamClient } from "@/lib/ws/doc-stream-client"

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
  activeLeases: Map<number, ReturnType<typeof setTimeout>>
}

interface ViewOwner {
  surfaceId: string
  detachCallback: () => void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_WARM_BUDGET = 10
const LEASE_SAFETY_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// SessionPool
// ---------------------------------------------------------------------------

export class SessionPool {
  private readonly sessions = new Map<string, PoolEntry>()
  private readonly inflightCreations = new Map<string, Promise<DocSession>>()
  private readonly inflightDestroys = new Map<string, Promise<void>>()
  private readonly viewOwners = new Map<string, ViewOwner>()
  private readonly listeners = new Set<() => void>()
  private readonly idleMs: number
  private readonly warmBudget: number
  private readonly userId: string
  private readonly userName: string
  private readonly wsFactory?: DocumentWsProviderFactory
  private docStreamClient: DocStreamClient | null = null
  private nextLeaseId = 1
  private destroyed = false

  constructor(config: SessionPoolConfig) {
    this.idleMs = config.idleMs ?? DEFAULT_IDLE_MS
    this.warmBudget = config.warmBudget ?? DEFAULT_WARM_BUDGET
    this.userId = config.user.userId
    this.userName = config.user.userName
    this.wsFactory = config.wsFactory
  }

  /**
   * Inject the DocStreamClient from React context.
   *
   * Called via useEffect in SessionPoolContext when the DocStreamClient
   * changes. The pool passes this to the DocumentWsProviderFactory when
   * creating providers.
   */
  setDocStreamClient(client: DocStreamClient): void {
    this.docStreamClient = client
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

  /** Get the current view owner surface ID for a doc, if any. */
  getViewOwnerSurfaceId(id: string): string | null {
    return this.viewOwners.get(id)?.surfaceId ?? null
  }

  /** Register the surface that currently owns the live view for this doc. */
  registerViewOwner(
    id: string,
    surfaceId: string,
    detachCb: () => void,
  ): void {
    this.assertNotDestroyed()
    this.viewOwners.set(id, { surfaceId, detachCallback: detachCb })
  }

  /**
   * Unregister the current view owner if the caller still owns the record.
   * Mismatched surface IDs are ignored to prevent accidental cross-surface clears.
   */
  unregisterViewOwner(id: string, surfaceId: string): void {
    this.assertNotDestroyed()
    const owner = this.viewOwners.get(id)
    if (!owner) return
    if (owner.surfaceId !== surfaceId) return
    this.viewOwners.delete(id)
  }

  /**
   * Request ownership transfer for a doc to a new surface.
   * If another surface currently owns the view, its detach callback is invoked
   * synchronously so it can hide/destroy and unregister before takeover.
   */
  requestTransfer(id: string, newSurfaceId: string): void {
    this.assertNotDestroyed()
    const owner = this.viewOwners.get(id)
    if (!owner) return
    if (owner.surfaceId === newSurfaceId) return
    owner.detachCallback()
  }

  /**
   * Acquire a temporary non-evictable lease for a session.
   *
   * While at least one lease is active, the session is excluded from:
   *   - Idle timeout eviction
   *   - Warm-budget detached eviction
   *
   * Returns an idempotent release function. A 5s safety timeout auto-releases
   * if the caller forgets to release.
   */
  acquireLease(id: string): () => void {
    this.assertNotDestroyed()

    const entry = this.sessions.get(id)
    if (!entry) {
      throw new Error(`Cannot lease missing session: ${id}`)
    }
    if (entry.session.isFrozen) {
      throw new Error(`Cannot lease frozen session: ${id}`)
    }

    // New lease epoch cancels stale idle timers.
    entry.session.generation++

    // If an idle timer exists, cancel it now; release() will reschedule if needed.
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }

    const leaseId = this.nextLeaseId++
    const timeout = setTimeout(() => {
      this.releaseLease(id, leaseId)
    }, LEASE_SAFETY_TIMEOUT_MS)

    entry.activeLeases.set(leaseId, timeout)
    this.notify()

    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseLease(id, leaseId)
    }
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

    // Invalidate all active leases first so no lease state survives teardown.
    // This also cancels lease safety timeouts to avoid post-destroy callbacks.
    for (const entry of this.sessions.values()) {
      if (entry.activeLeases.size > 0) {
        entry.session.generation++
      }
      for (const timeout of entry.activeLeases.values()) {
        clearTimeout(timeout)
      }
      entry.activeLeases.clear()
    }

    // Cancel all idle timers to prevent races during teardown
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
      this.viewOwners.clear()
      this.listeners.clear()
    }
  }

  /** Expose destroyed state for callers that guard async races. */
  get isDestroyed(): boolean {
    return this.destroyed
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
      docStreamClient: this.docStreamClient ?? undefined,
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

    const entry: PoolEntry = { session, idleTimer: null, activeLeases: new Map() }
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
    // Leased sessions are explicitly non-evictable while lease is active.
    if (entry.activeLeases.size > 0) {
      return
    }

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
      if (
        entry.session.attachedViewCount === 0
        && !entry.session.isFrozen
        && entry.activeLeases.size === 0
      ) {
        result.push({ session: entry.session, entry })
      }
    }
    return result
  }

  /** Destroy a single session: cancel timer, destroy session, remove from pool. */
  private async destroySession(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (!entry) return

    // Cancel lease safety timers for this entry before removal.
    for (const timeout of entry.activeLeases.values()) {
      clearTimeout(timeout)
    }
    entry.activeLeases.clear()

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

  /** Internal lease release helper shared by explicit and timeout releases. */
  private releaseLease(id: string, leaseId: number): void {
    const entry = this.sessions.get(id)
    if (!entry) return

    const timeout = entry.activeLeases.get(leaseId)
    if (!timeout) return

    clearTimeout(timeout)
    entry.activeLeases.delete(leaseId)

    // If detached and no remaining lease, restore idle eviction behavior.
    if (
      !this.destroyed
      && entry.session.attachedViewCount === 0
      && !entry.session.isFrozen
      && entry.activeLeases.size === 0
    ) {
      this.startIdleTimer(id, entry)
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
