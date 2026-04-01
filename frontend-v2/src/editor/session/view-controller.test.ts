import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import type { EditorView } from "@codemirror/view"

import type { DocSession } from "./doc-session"
import type { SessionPool } from "./session-pool"
import { type ViewRestoreState, ViewController } from "./view-controller"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeMockSession(id: string): DocSession {
  const ydoc = new Y.Doc()
  const awareness = {
    setLocalStateField: vi.fn(),
  }

  return {
    id,
    ydoc,
    ytext: ydoc.getText("content"),
    awareness: awareness as never,
    undoManager: {} as never,
    idbPersistence: {
      synced: Promise.resolve({ timedOut: false }),
      getHealth: () => ({ status: "healthy", timedOut: false, lastError: null }),
      subscribeHealth: () => () => {},
      clearData: async () => {},
      destroy: async () => {},
      provider: {} as never,
    },
    attachedViewCount: 0,
    generation: 0,
    lastDetachedAt: null,
    frozenReason: null,
    hasPendingLocalChanges: false,
    syncState: "disconnected",
    connectionState: "disconnected",
    wsProvider: null,
    initialize: async () => ({ timedOut: false }),
    getIdbHealth: () => ({ status: "healthy", timedOut: false, lastError: null }),
    subscribeIdbHealth: () => () => {},
    subscribe: () => () => {},
    freeze: () => {},
    get isFrozen() {
      return false
    },
    destroy: async () => {
      ydoc.destroy()
    },
  } as unknown as DocSession
}

interface MockAwareness {
  setLocalStateField: ReturnType<typeof vi.fn>
}

function getMockAwareness(session: DocSession): MockAwareness {
  return session.awareness as unknown as MockAwareness
}

interface MockEditorView {
  view: EditorView
  requestMeasure: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function makeMockEditorView(initialHead = 0): MockEditorView {
  const requestMeasure = vi.fn((measure?: { write?: (m: unknown, v: EditorView) => void }) => {
    measure?.write?.({}, view)
  })
  const focus = vi.fn()
  const dispatch = vi.fn((spec: { selection?: { anchor: number; head: number } }) => {
    const selection = spec.selection
    if (!selection) return
    view.state.selection.main = {
      from: selection.anchor,
      to: selection.head,
      head: selection.head,
    }
  })
  const destroy = vi.fn()

  const view = {
    state: {
      selection: {
        main: {
          from: initialHead,
          to: initialHead,
          head: initialHead,
        },
      },
    },
    scrollDOM: { scrollTop: 0, scrollLeft: 0 },
    requestMeasure,
    focus,
    dispatch,
    destroy,
  } as unknown as EditorView

  return { view, requestMeasure, focus, dispatch, destroy }
}

class FakeSessionPool {
  destroyed = false

  readonly ensureCalls: string[] = []
  readonly releaseCalls: string[] = []
  readonly registerCalls: Array<{ id: string; surfaceId: string }> = []
  readonly unregisterCalls: Array<{ id: string; surfaceId: string }> = []
  readonly transferCalls: Array<{ id: string; newSurfaceId: string }> = []
  readonly leaseCalls: string[] = []
  readonly eventLog: string[] = []

  private readonly sessions = new Map<string, DocSession>()
  private readonly deferred = new Map<string, Deferred<DocSession>>()
  private readonly owners = new Map<string, { surfaceId: string; detachCb: () => void }>()

  get isDestroyed(): boolean {
    return this.destroyed
  }

  deferEnsure(id: string): void {
    this.deferred.set(id, createDeferred<DocSession>())
  }

  resolveEnsure(id: string): void {
    const pending = this.deferred.get(id)
    if (!pending) return

    const session = this.getOrCreateSession(id)
    pending.resolve(session)
    this.deferred.delete(id)
  }

  async ensureSession(id: string): Promise<DocSession> {
    this.ensureCalls.push(id)
    this.eventLog.push(`ensure:${id}`)

    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }

    const pending = this.deferred.get(id)
    if (pending) {
      return pending.promise
    }

    return this.getOrCreateSession(id)
  }

  releaseSession(id: string): void {
    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }

    this.releaseCalls.push(id)
    this.eventLog.push(`release:${id}`)

    const session = this.sessions.get(id)
    if (session) {
      session.attachedViewCount = 0
      session.lastDetachedAt = Date.now()
    }
  }

  getViewOwnerSurfaceId(id: string): string | null {
    return this.owners.get(id)?.surfaceId ?? null
  }

  registerViewOwner(id: string, surfaceId: string, detachCb: () => void): void {
    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }

    this.registerCalls.push({ id, surfaceId })
    this.eventLog.push(`register:${id}:${surfaceId}`)
    this.owners.set(id, { surfaceId, detachCb })
  }

  unregisterViewOwner(id: string, surfaceId: string): void {
    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }

    this.unregisterCalls.push({ id, surfaceId })
    this.eventLog.push(`unregister:${id}:${surfaceId}`)

    const owner = this.owners.get(id)
    if (!owner) return
    if (owner.surfaceId !== surfaceId) return
    this.owners.delete(id)
  }

  requestTransfer(id: string, newSurfaceId: string): void {
    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }

    this.transferCalls.push({ id, newSurfaceId })
    this.eventLog.push(`transfer:${id}:${newSurfaceId}`)

    const owner = this.owners.get(id)
    if (!owner || owner.surfaceId === newSurfaceId) {
      return
    }

    owner.detachCb()
  }

  acquireLease(id: string): () => void {
    if (this.destroyed) {
      throw new Error("SessionPool has been destroyed")
    }

    this.leaseCalls.push(id)
    this.eventLog.push(`lease:${id}`)

    let released = false
    return () => {
      if (released) return
      released = true
      this.eventLog.push(`lease-release:${id}`)
    }
  }

  private getOrCreateSession(id: string): DocSession {
    const existing = this.sessions.get(id)
    if (existing) {
      return existing
    }

    const session = makeMockSession(id)
    this.sessions.set(id, session)
    return session
  }
}

describe("ViewController", () => {
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement("div")
    document.body.appendChild(host)
  })

  it("evicts the least-recently-used hidden view when maxLive is exceeded", async () => {
    const pool = new FakeSessionPool()
    const created: Array<{ id: string; restore: ViewRestoreState | null | undefined; mock: MockEditorView }> = []

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      maxLive: 2,
      createEditorView: ({ session, restore }) => {
        const mock = makeMockEditorView()
        created.push({ id: session.id, restore, mock })
        return mock.view
      },
    })

    controller.setHost(host)

    await controller.activate({ id: "doc-1", name: "One" })
    await controller.activate({ id: "doc-2", name: "Two" })
    await controller.activate({ id: "doc-3", name: "Three" })

    expect(created).toHaveLength(3)
    expect(created[0].mock.destroy).toHaveBeenCalledTimes(1)
    expect(pool.releaseCalls).toContain("doc-1")

    // Reactivating the evicted document creates a fresh view with restore hints.
    await controller.activate({ id: "doc-1", name: "One" })
    expect(created).toHaveLength(4)
    expect(created[3].id).toBe("doc-1")
    expect(created[3].restore).not.toBeNull()
  })

  it("serializes async activate calls by epoch and resolves rapid A->B->C to C", async () => {
    const pool = new FakeSessionPool()
    pool.deferEnsure("doc-a")
    pool.deferEnsure("doc-b")
    pool.deferEnsure("doc-c")

    const createEditorView = vi.fn(() => makeMockEditorView().view)

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView,
    })

    controller.setHost(host)

    const pA = controller.activate({ id: "doc-a", name: "A" })
    const pB = controller.activate({ id: "doc-b", name: "B" })
    const pC = controller.activate({ id: "doc-c", name: "C" })

    pool.resolveEnsure("doc-a")
    pool.resolveEnsure("doc-b")
    pool.resolveEnsure("doc-c")

    const [viewA, viewB, viewC] = await Promise.all([pA, pB, pC])

    expect(viewA).toBeNull()
    expect(viewB).toBeNull()
    expect(viewC).not.toBeNull()
    expect(controller.getActiveDocId()).toBe("doc-c")
    expect(createEditorView).toHaveBeenCalledTimes(1)
    expect(createEditorView.mock.calls[0][0].session.id).toBe("doc-c")
  })

  it("transfers lease across surfaces when another controller owns the live view", async () => {
    const pool = new FakeSessionPool()

    const primaryViews: MockEditorView[] = []
    const secondaryViews: MockEditorView[] = []

    const studio = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView: () => {
        const mock = makeMockEditorView()
        primaryViews.push(mock)
        return mock.view
      },
    })

    const converse = new ViewController({
      surfaceId: "converse",
      sessionPool: pool as unknown as SessionPool,
      createEditorView: () => {
        const mock = makeMockEditorView()
        secondaryViews.push(mock)
        return mock.view
      },
    })

    const studioHost = document.createElement("div")
    const converseHost = document.createElement("div")
    document.body.appendChild(studioHost)
    document.body.appendChild(converseHost)

    studio.setHost(studioHost)
    converse.setHost(converseHost)

    await studio.activate({ id: "doc-1", name: "Doc" })
    expect(pool.getViewOwnerSurfaceId("doc-1")).toBe("studio")

    await converse.activate({ id: "doc-1", name: "Doc" })

    expect(pool.leaseCalls).toEqual(["doc-1"])
    expect(pool.transferCalls).toEqual([{ id: "doc-1", newSurfaceId: "converse" }])
    expect(primaryViews[0].destroy).toHaveBeenCalledTimes(1)
    expect(pool.getViewOwnerSurfaceId("doc-1")).toBe("converse")
    expect(converse.getActiveView()).toBe(secondaryViews[0].view)

    expect(pool.eventLog).toContain("lease:doc-1")
    expect(pool.eventLog).toContain("transfer:doc-1:converse")
    expect(pool.eventLog).toContain("register:doc-1:converse")

    const transferIdx = pool.eventLog.indexOf("transfer:doc-1:converse")
    const unregisterIdx = pool.eventLog.indexOf("unregister:doc-1:studio")
    const registerIdx = pool.eventLog.indexOf("register:doc-1:converse")
    expect(unregisterIdx).toBeGreaterThan(transferIdx)
    expect(unregisterIdx).toBeLessThan(registerIdx)
  })

  it("destroys view and releases session on close", async () => {
    const pool = new FakeSessionPool()
    const created: MockEditorView[] = []

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView: () => {
        const mock = makeMockEditorView()
        created.push(mock)
        return mock.view
      },
    })

    controller.setHost(host)

    await controller.activate({ id: "doc-1", name: "Doc" })
    await controller.close("doc-1")

    expect(created[0].destroy).toHaveBeenCalledTimes(1)
    expect(pool.releaseCalls).toContain("doc-1")
    expect(controller.getOpenDocuments()).toEqual([])
    expect(controller.getActiveDocId()).toBeNull()
  })

  it("invalidates pending cold activate when close happens mid-ensureSession", async () => {
    const pool = new FakeSessionPool()
    pool.deferEnsure("doc-1")
    const createEditorView = vi.fn(() => makeMockEditorView().view)

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView,
    })

    controller.setHost(host)

    const activation = controller.activate({ id: "doc-1", name: "Doc" })
    await controller.close("doc-1")
    pool.resolveEnsure("doc-1")

    await expect(activation).resolves.toBeNull()
    expect(createEditorView).not.toHaveBeenCalled()
    expect(controller.getActiveDocId()).toBeNull()
    expect(controller.getOpenDocuments()).toEqual([])
    expect(host.querySelector('[data-document-id="doc-1"]')).toBeNull()
    expect(pool.releaseCalls.filter((id) => id === "doc-1").length).toBeGreaterThan(0)
  })

  it("releases lease and rolls back state when requestTransfer throws", async () => {
    const pool = new FakeSessionPool()
    await pool.ensureSession("doc-1")
    pool.registerViewOwner("doc-1", "other-surface", vi.fn())

    const createEditorView = vi.fn(() => makeMockEditorView().view)
    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView,
    })

    controller.setHost(host)

    const transferError = new Error("transfer failed")
    const transferSpy = vi
      .spyOn(pool, "requestTransfer")
      .mockImplementation(() => {
        throw transferError
      })

    await expect(controller.activate({ id: "doc-1", name: "Doc" })).rejects.toThrow(
      "transfer failed",
    )

    expect(pool.eventLog).toContain("lease:doc-1")
    expect(pool.eventLog).toContain("lease-release:doc-1")
    expect(pool.releaseCalls).toContain("doc-1")
    expect(controller.getActiveDocId()).toBeNull()
    expect(controller.getActiveView()).toBeNull()
    expect(host.querySelector('[data-document-id="doc-1"]')).toBeNull()

    transferSpy.mockRestore()
    await expect(controller.activate({ id: "doc-1", name: "Doc" })).resolves.not.toBeNull()
  })

  it("rolls back entry state and releases session when createEditorView throws", async () => {
    const pool = new FakeSessionPool()
    const createError = new Error("createEditorView failed")
    let shouldThrow = true
    const createEditorView = vi.fn(() => {
      if (shouldThrow) {
        shouldThrow = false
        throw createError
      }
      return makeMockEditorView().view
    })

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView,
    })

    controller.setHost(host)

    await expect(controller.activate({ id: "doc-1", name: "Doc" })).rejects.toThrow(
      "createEditorView failed",
    )
    expect(pool.releaseCalls).toContain("doc-1")
    expect(controller.getActiveDocId()).toBeNull()
    expect(controller.getActiveView()).toBeNull()
    expect(host.querySelector('[data-document-id="doc-1"]')).toBeNull()

    await expect(controller.activate({ id: "doc-1", name: "Doc" })).resolves.not.toBeNull()
    expect(controller.getActiveDocId()).toBe("doc-1")
  })

  it("treats double-close on the same doc as a no-op", async () => {
    const pool = new FakeSessionPool()
    const created: MockEditorView[] = []
    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView: () => {
        const mock = makeMockEditorView()
        created.push(mock)
        return mock.view
      },
    })

    controller.setHost(host)

    await controller.activate({ id: "doc-1", name: "Doc" })
    await controller.close("doc-1")

    const releasesAfterFirstClose = pool.releaseCalls.length
    const destroysAfterFirstClose = created[0].destroy.mock.calls.length

    await controller.close("doc-1")

    expect(pool.releaseCalls.length).toBe(releasesAfterFirstClose)
    expect(created[0].destroy).toHaveBeenCalledTimes(destroysAfterFirstClose)
    expect(controller.getOpenDocuments()).toEqual([])
    expect(controller.getActiveDocId()).toBeNull()
  })

  it("does not recreate a view when activating the same doc twice", async () => {
    const pool = new FakeSessionPool()
    const createEditorView = vi.fn(() => makeMockEditorView().view)

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView,
    })

    controller.setHost(host)

    const first = await controller.activate({ id: "doc-1", name: "Doc" })
    const second = await controller.activate({ id: "doc-1", name: "Doc" })

    expect(first).toBe(second)
    expect(createEditorView).toHaveBeenCalledTimes(1)
  })

  it("aborts activate when the pool is destroyed while awaiting ensureSession", async () => {
    const pool = new FakeSessionPool()
    pool.deferEnsure("doc-1")

    const createEditorView = vi.fn(() => makeMockEditorView().view)

    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView,
    })

    controller.setHost(host)

    const activation = controller.activate({ id: "doc-1", name: "Doc" })

    pool.destroyed = true
    pool.resolveEnsure("doc-1")

    await expect(activation).resolves.toBeNull()
    expect(createEditorView).not.toHaveBeenCalled()
    expect(controller.getActiveDocId()).toBeNull()
  })

  it("updates snapshot via rename and setModified mutators", async () => {
    const pool = new FakeSessionPool()
    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView: () => makeMockEditorView().view,
    })

    controller.setHost(host)
    await controller.activate({ id: "doc-1", name: "Initial" })

    controller.rename("doc-1", "Renamed")
    controller.setModified("doc-1", true)

    expect(controller.getSnapshot()).toEqual({
      activeDocId: "doc-1",
      openDocs: [{ id: "doc-1", name: "Renamed", isModified: true }],
    })
  })

  it("clears cursor awareness on hide and republishes on show", async () => {
    const pool = new FakeSessionPool()
    const docOneSession = await pool.ensureSession("doc-1")
    const docTwoSession = await pool.ensureSession("doc-2")

    const created = new Map<string, MockEditorView>()
    const controller = new ViewController({
      surfaceId: "studio",
      sessionPool: pool as unknown as SessionPool,
      createEditorView: ({ session }) => {
        const mock = makeMockEditorView()
        created.set(session.id, mock)
        return mock.view
      },
    })

    controller.setHost(host)

    await controller.activate({ id: "doc-1", name: "Doc 1" })
    await controller.activate({ id: "doc-2", name: "Doc 2" })
    await controller.activate({ id: "doc-1", name: "Doc 1" })

    const docOneAwareness = getMockAwareness(docOneSession)
    const docTwoAwareness = getMockAwareness(docTwoSession)
    const docOneView = created.get("doc-1")
    const docTwoView = created.get("doc-2")

    expect(docOneAwareness.setLocalStateField).toHaveBeenCalledWith("cursor", null)
    expect(docTwoAwareness.setLocalStateField).toHaveBeenCalledWith("cursor", null)
    expect(docOneView?.dispatch).toHaveBeenCalledTimes(2)
    expect(docTwoView?.dispatch).toHaveBeenCalledTimes(1)
  })
})
