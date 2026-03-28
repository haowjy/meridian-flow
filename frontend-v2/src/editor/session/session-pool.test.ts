import "fake-indexeddb/auto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { IdbPersistenceHandle } from "../collab/idb-persistence"
import { DocSession } from "./doc-session"
import { SessionPool, type SessionPoolConfig } from "./session-pool"

// ---------------------------------------------------------------------------
// Mock IDB persistence — resolves instantly so fake timers don't block
// DocSession.initialize(). We're testing SessionPool, not IDB sync.
// ---------------------------------------------------------------------------

vi.mock("../collab/idb-persistence", () => ({
  createIdbPersistence: (): IdbPersistenceHandle => ({
    provider: {} as never,
    synced: Promise.resolve({ timedOut: false }),
    getHealth: () => ({ status: "healthy" as const, timedOut: false, lastError: null }),
    subscribeHealth: () => () => {},
    clearData: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePoolConfig(
  overrides: Partial<SessionPoolConfig> = {},
): SessionPoolConfig {
  return {
    user: { userId: "user-1", userName: "Test User" },
    ...overrides,
  }
}

function makePool(overrides: Partial<SessionPoolConfig> = {}): SessionPool {
  return new SessionPool(makePoolConfig(overrides))
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SessionPool", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // ensureSession
  // -----------------------------------------------------------------------

  describe("ensureSession", () => {
    it("creates a new session and returns it", async () => {
      const pool = makePool()
      const session = await pool.ensureSession("doc-1")

      expect(session).toBeInstanceOf(DocSession)
      expect(session.id).toBe("doc-1")

      await pool.destroy()
    })

    it("returns the same session on second call (idempotent)", async () => {
      const pool = makePool()
      const first = await pool.ensureSession("doc-1")
      const second = await pool.ensureSession("doc-1")

      expect(first).toBe(second)

      await pool.destroy()
    })

    it("increments generation on each call", async () => {
      const pool = makePool()
      const session = await pool.ensureSession("doc-1")
      const genAfterCreate = session.generation

      await pool.ensureSession("doc-1")
      expect(session.generation).toBe(genAfterCreate + 1)

      await pool.destroy()
    })

    it("deduplicates concurrent calls for the same ID", async () => {
      const pool = makePool()

      // Fire two ensureSession calls concurrently — both should resolve
      // to the same DocSession instance (no double-init).
      const [a, b] = await Promise.all([
        pool.ensureSession("doc-1"),
        pool.ensureSession("doc-1"),
      ])

      expect(a).toBe(b)
      expect(a).toBeInstanceOf(DocSession)

      await pool.destroy()
    })

    it("creates a fresh session after destroy-during-inflight-creation", async () => {
      const pool = makePool({ idleMs: 100 })

      // Create and release a session so it starts idle timer
      const first = await pool.ensureSession("doc-1")
      pool.releaseSession("doc-1")

      // Advance past the idle timeout to trigger async destruction
      await vi.advanceTimersByTimeAsync(101)

      // Session should be gone from pool
      expect(pool.getSession("doc-1")).toBeNull()

      // Create a new one — should succeed (destroy has completed)
      const second = await pool.ensureSession("doc-1")

      expect(second).toBeInstanceOf(DocSession)
      expect(second).not.toBe(first)

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // preload
  // -----------------------------------------------------------------------

  describe("preload", () => {
    it("creates a warm session", async () => {
      const pool = makePool()
      const session = await pool.preload("doc-1")

      expect(session).toBeInstanceOf(DocSession)
      expect(session.id).toBe("doc-1")
      expect(pool.getSession("doc-1")).toBe(session)

      await pool.destroy()
    })

    it("returns existing session if already warm", async () => {
      const pool = makePool()
      const first = await pool.preload("doc-1")
      const second = await pool.preload("doc-1")

      expect(first).toBe(second)

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // releaseSession
  // -----------------------------------------------------------------------

  describe("releaseSession", () => {
    it("sets attachedViewCount to 0 and records lastDetachedAt", async () => {
      const pool = makePool()
      const session = await pool.ensureSession("doc-1")
      session.attachedViewCount = 1

      const before = Date.now()
      pool.releaseSession("doc-1")

      expect(session.attachedViewCount).toBe(0)
      expect(session.lastDetachedAt).toBeGreaterThanOrEqual(before)

      await pool.destroy()
    })

    it("is a no-op for non-existent session", () => {
      const pool = makePool()
      // Should not throw
      pool.releaseSession("nonexistent")
    })
  })

  // -----------------------------------------------------------------------
  // Idle timeout
  // -----------------------------------------------------------------------

  describe("idle timeout", () => {
    it("destroys a detached session after idle timeout", async () => {
      const pool = makePool({ idleMs: 1000 })
      await pool.ensureSession("doc-1")

      pool.releaseSession("doc-1")
      expect(pool.getSession("doc-1")).not.toBeNull()

      // Advance past the idle timeout
      await vi.advanceTimersByTimeAsync(1001)

      expect(pool.getSession("doc-1")).toBeNull()

      await pool.destroy()
    })

    it("does NOT destroy session before idle timeout", async () => {
      const pool = makePool({ idleMs: 5000 })
      await pool.ensureSession("doc-1")

      pool.releaseSession("doc-1")

      // Advance 4 seconds — not yet expired
      await vi.advanceTimersByTimeAsync(4000)
      expect(pool.getSession("doc-1")).not.toBeNull()

      await pool.destroy()
    })

    it("stale idle timer does NOT destroy a re-borrowed session (generation guard)", async () => {
      const pool = makePool({ idleMs: 1000 })
      const session = await pool.ensureSession("doc-1")
      session.attachedViewCount = 1

      // Surface A releases — timer starts
      pool.releaseSession("doc-1")
      const genAtRelease = session.generation

      // Surface B re-borrows before timer fires — generation increments
      await pool.ensureSession("doc-1")
      expect(session.generation).toBe(genAtRelease + 1)
      session.attachedViewCount = 1

      // Timer fires — should be a no-op because generation changed
      await vi.advanceTimersByTimeAsync(1001)

      expect(pool.getSession("doc-1")).not.toBeNull()
      expect(session.attachedViewCount).toBe(1)

      await pool.destroy()
    })

    it("stale timer is no-op even if session is detached again after re-borrow", async () => {
      const pool = makePool({ idleMs: 1000 })
      const session = await pool.ensureSession("doc-1")
      session.attachedViewCount = 1

      // Release (timer 1 starts at gen N)
      pool.releaseSession("doc-1")

      // Advance 500ms (half the timeout)
      await vi.advanceTimersByTimeAsync(500)

      // Re-borrow (gen increments)
      await pool.ensureSession("doc-1")
      session.attachedViewCount = 1

      // Release again (timer 2 starts at new gen)
      pool.releaseSession("doc-1")

      // Timer 1 fires at 1000ms — should be stale (no-op)
      await vi.advanceTimersByTimeAsync(500)
      expect(pool.getSession("doc-1")).not.toBeNull()

      // Timer 2 fires at 1500ms — should destroy
      await vi.advanceTimersByTimeAsync(500)
      expect(pool.getSession("doc-1")).toBeNull()

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Warm budget eviction
  // -----------------------------------------------------------------------

  describe("warm budget eviction", () => {
    it("evicts the oldest idle session when budget exceeded", async () => {
      const pool = makePool({ warmBudget: 2, idleMs: 60_000 })

      // Create and release 2 sessions (at budget)
      await pool.ensureSession("doc-1")
      pool.releaseSession("doc-1")

      vi.advanceTimersByTime(100) // give doc-1 an earlier lastDetachedAt

      await pool.ensureSession("doc-2")
      pool.releaseSession("doc-2")

      expect(pool.getSession("doc-1")).not.toBeNull()
      expect(pool.getSession("doc-2")).not.toBeNull()

      // Creating doc-3 (detached by default, attachedViewCount === 0)
      // should evict doc-1 (oldest lastDetachedAt)
      await pool.ensureSession("doc-3")
      pool.releaseSession("doc-3")

      // doc-1 should be evicted (oldest), doc-2 and doc-3 remain
      expect(pool.getSession("doc-1")).toBeNull()
      expect(pool.getSession("doc-2")).not.toBeNull()
      expect(pool.getSession("doc-3")).not.toBeNull()

      await pool.destroy()
    })

    it("only evicts detached sessions, not attached ones", async () => {
      const pool = makePool({ warmBudget: 1, idleMs: 60_000 })

      // Create an attached session
      const attached = await pool.ensureSession("doc-attached")
      attached.attachedViewCount = 1

      // Create and release a detached session
      await pool.ensureSession("doc-detached")
      pool.releaseSession("doc-detached")

      // Create another session — budget is 1, only detached sessions count.
      // doc-detached should be evicted, doc-attached should stay.
      await pool.ensureSession("doc-new")

      expect(pool.getSession("doc-attached")).not.toBeNull()
      expect(pool.getSession("doc-detached")).toBeNull()
      expect(pool.getSession("doc-new")).not.toBeNull()

      await pool.destroy()
    })

    it("does NOT evict frozen sessions from budget", async () => {
      const pool = makePool({ warmBudget: 1, idleMs: 60_000 })

      // Create a detached session and freeze it
      await pool.ensureSession("doc-frozen")
      pool.releaseSession("doc-frozen")
      await pool.invalidateSession("doc-frozen", "document-deleted")

      // Create a detached session (at budget)
      await pool.ensureSession("doc-normal")
      pool.releaseSession("doc-normal")

      // Create another session — exceeds budget, but doc-frozen is
      // excluded from eviction, so only doc-normal is a candidate.
      await pool.ensureSession("doc-new")
      pool.releaseSession("doc-new")

      // Frozen session survives eviction
      expect(pool.getSession("doc-frozen")).not.toBeNull()
      expect(pool.getSession("doc-frozen")!.isFrozen).toBe(true)
      // doc-normal was the oldest evictable detached session
      expect(pool.getSession("doc-normal")).toBeNull()
      expect(pool.getSession("doc-new")).not.toBeNull()

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // invalidateSession
  // -----------------------------------------------------------------------

  describe("invalidateSession", () => {
    it("freezes the session and increments generation", async () => {
      const pool = makePool()
      const session = await pool.ensureSession("doc-1")
      const genBefore = session.generation

      await pool.invalidateSession("doc-1", "document-deleted")

      expect(session.isFrozen).toBe(true)
      expect(session.frozenReason).toBe("document-deleted")
      expect(session.generation).toBe(genBefore + 1)

      await pool.destroy()
    })

    it("cancels pending idle timer via generation guard", async () => {
      const pool = makePool({ idleMs: 1000 })
      await pool.ensureSession("doc-1")

      // Release starts idle timer
      pool.releaseSession("doc-1")

      // Invalidate increments generation — stale timer should be no-op
      await pool.invalidateSession("doc-1", "access-revoked")

      // Timer fires — session should still be in pool (invalidated but present)
      await vi.advanceTimersByTimeAsync(1001)

      expect(pool.getSession("doc-1")).not.toBeNull()
      expect(pool.getSession("doc-1")!.isFrozen).toBe(true)

      await pool.destroy()
    })

    it("is a no-op for non-existent session", async () => {
      const pool = makePool()
      // Should not throw
      await pool.invalidateSession("nonexistent", "document-deleted")

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // getSession
  // -----------------------------------------------------------------------

  describe("getSession", () => {
    it("returns null for non-existent session", () => {
      const pool = makePool()
      expect(pool.getSession("nonexistent")).toBeNull()
    })

    it("returns session when it exists", async () => {
      const pool = makePool()
      const session = await pool.ensureSession("doc-1")
      expect(pool.getSession("doc-1")).toBe(session)

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // getSessionIds
  // -----------------------------------------------------------------------

  describe("getSessionIds", () => {
    it("returns all active session IDs", async () => {
      const pool = makePool()
      await pool.ensureSession("doc-1")
      await pool.ensureSession("doc-2")

      const ids = pool.getSessionIds()
      expect(ids.sort()).toEqual(["doc-1", "doc-2"])

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // subscribe
  // -----------------------------------------------------------------------

  describe("subscribe", () => {
    it("notifies on session creation", async () => {
      const pool = makePool()
      const listener = vi.fn()
      pool.subscribe(listener)

      await pool.ensureSession("doc-1")

      expect(listener).toHaveBeenCalled()

      await pool.destroy()
    })

    it("notifies on session release", async () => {
      const pool = makePool()
      const listener = vi.fn()

      await pool.ensureSession("doc-1")
      pool.subscribe(listener)
      listener.mockClear()

      pool.releaseSession("doc-1")

      expect(listener).toHaveBeenCalled()

      await pool.destroy()
    })

    it("notifies on warm re-borrow", async () => {
      const pool = makePool()
      const listener = vi.fn()

      await pool.ensureSession("doc-1")
      pool.subscribe(listener)
      listener.mockClear()

      await pool.ensureSession("doc-1")

      expect(listener).toHaveBeenCalled()

      await pool.destroy()
    })

    it("notifies on session destruction (idle timeout)", async () => {
      const pool = makePool({ idleMs: 1000 })
      const listener = vi.fn()

      await pool.ensureSession("doc-1")
      pool.subscribe(listener)
      listener.mockClear()

      pool.releaseSession("doc-1")
      await vi.advanceTimersByTimeAsync(1001)

      expect(listener).toHaveBeenCalled()

      await pool.destroy()
    })

    it("notifies on invalidation", async () => {
      const pool = makePool()
      const listener = vi.fn()

      await pool.ensureSession("doc-1")
      pool.subscribe(listener)
      listener.mockClear()

      await pool.invalidateSession("doc-1", "document-deleted")

      expect(listener).toHaveBeenCalled()

      await pool.destroy()
    })

    it("unsubscribe stops notifications", async () => {
      const pool = makePool()
      const listener = vi.fn()
      const unsub = pool.subscribe(listener)

      unsub()
      await pool.ensureSession("doc-1")

      expect(listener).not.toHaveBeenCalled()

      await pool.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  describe("destroy", () => {
    it("cleans up all sessions and timers", async () => {
      const pool = makePool({ idleMs: 60_000 })
      await pool.ensureSession("doc-1")
      await pool.ensureSession("doc-2")
      pool.releaseSession("doc-1") // starts idle timer

      await pool.destroy()

      expect(pool.getSessionIds()).toEqual([])
    })

    it("is safe to call multiple times", async () => {
      const pool = makePool()
      await pool.ensureSession("doc-1")

      await pool.destroy()
      await pool.destroy() // Should not throw
    })

    it("prevents further ensureSession calls", async () => {
      const pool = makePool()
      await pool.destroy()

      await expect(pool.ensureSession("doc-1")).rejects.toThrow(
        "SessionPool has been destroyed",
      )
    })
  })
})
