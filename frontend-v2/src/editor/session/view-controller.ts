import type { EditorView } from "@codemirror/view"
import * as Y from "yjs"

import {
  clearCursorAwareness,
  refreshCursorAwareness,
} from "./awareness-lifecycle"
import type { DocSession } from "./doc-session"
import { SessionPool } from "./session-pool"

export interface ScrollSnapshot {
  scrollTop: number
  scrollLeft: number
}

export interface ViewRestoreState {
  scroll: ScrollSnapshot | null
  selection: Y.RelativePosition | null
}

export interface DocHandle {
  id: string
  name: string
}

export interface OpenDoc {
  id: string
  name: string
  isModified: boolean
}

export interface ViewControllerSnapshot {
  activeDocId: string | null
  openDocs: OpenDoc[]
}

export interface ViewControllerOptions {
  surfaceId: string
  sessionPool: SessionPool
  maxLive?: number
  createEditorView(args: {
    session: DocSession
    container: HTMLDivElement
    restore?: ViewRestoreState | null
  }): EditorView
}

interface DocEntry {
  id: string
  name: string
  isModified: boolean
  session: DocSession | null
  view: EditorView | null
  containerEl: HTMLDivElement | null
  restore: ViewRestoreState | null
}

interface DetachOptions {
  captureRestore: boolean
  releaseSession: boolean
  unregisterOwner: boolean
}

const DEFAULT_MAX_LIVE = 6

export class ViewController {
  private readonly surfaceId: string
  private readonly sessionPool: SessionPool
  private readonly maxLive: number
  private readonly createEditorViewFn: ViewControllerOptions["createEditorView"]

  private hostEl: HTMLDivElement | null = null
  private readonly docs = new Map<string, DocEntry>()
  private lruOrder: string[] = []
  private activeDocId: string | null = null

  private readonly listeners = new Set<() => void>()
  private snapshot: ViewControllerSnapshot = { activeDocId: null, openDocs: [] }

  private destroyed = false
  private operationEpoch = 0

  constructor(options: ViewControllerOptions) {
    this.surfaceId = options.surfaceId
    this.sessionPool = options.sessionPool
    this.maxLive = options.maxLive ?? DEFAULT_MAX_LIVE
    this.createEditorViewFn = options.createEditorView
  }

  setHost(el: HTMLDivElement | null): void {
    this.hostEl = el
    if (!el) return

    for (const entry of this.docs.values()) {
      if (entry.containerEl && entry.containerEl.parentElement !== el) {
        el.appendChild(entry.containerEl)
      }
    }
  }

  async activate(doc: DocHandle): Promise<EditorView | null> {
    if (this.destroyed || this.sessionPool.isDestroyed) {
      return null
    }

    const epoch = ++this.operationEpoch

    let entry = this.docs.get(doc.id)
    let createdEntry = false
    if (entry) {
      entry.name = doc.name
    }

    // Fast path: activating the already-active live view is a no-op switch.
    if (entry && this.activeDocId === doc.id && entry.view) {
      this.showEntry(entry)
      this.emitChange()
      return entry.view
    }

    if (!entry) {
      entry = {
        id: doc.id,
        name: doc.name,
        isModified: false,
        session: null,
        view: null,
        containerEl: null,
        restore: null,
      }
      this.docs.set(doc.id, entry)
      createdEntry = true
    }

    if (!entry.session) {
      let session: DocSession
      try {
        session = await this.sessionPool.ensureSession(doc.id)
      } catch (error) {
        if (this.shouldAbort(epoch) || this.sessionPool.isDestroyed) {
          if (createdEntry) {
            this.docs.delete(doc.id)
          }
          return null
        }
        throw error
      }

      // Important race guard: if this activation went stale while awaiting
      // ensureSession(), release the borrowed session so it can idle-evict later.
      if (this.shouldAbortActivation(epoch, doc.id, entry)) {
        this.safeReleaseSession(doc.id)
        if (createdEntry) {
          this.docs.delete(doc.id)
        }
        return null
      }

      entry.session = session
    }

    this.hideActiveIfNeeded(doc.id)
    this.activeDocId = doc.id
    this.touchLru(doc.id)

    const ownerSurfaceId = this.sessionPool.getViewOwnerSurfaceId(doc.id)
    let releaseLease: (() => void) | null = null

    try {
      if (ownerSurfaceId && ownerSurfaceId !== this.surfaceId) {
        releaseLease = this.sessionPool.acquireLease(doc.id)
        if (this.shouldAbortActivation(epoch, doc.id, entry)) {
          return null
        }

        this.sessionPool.requestTransfer(doc.id, this.surfaceId)

        if (this.shouldAbortActivation(epoch, doc.id, entry)) {
          return null
        }
      }
      this.ensureView(entry)

      if (!entry.view) {
        this.emitChange()
        return null
      }

      // This callback is invoked synchronously by SessionPool.requestTransfer().
      this.sessionPool.registerViewOwner(doc.id, this.surfaceId, () => {
        this.detachOwnedView(doc.id)
      })

      entry.session!.attachedViewCount = 1
      this.showEntry(entry)
      this.evictIfNeeded()
    } catch (error) {
      this.rollbackFailedActivation(entry)
      if (this.activeDocId === doc.id) {
        this.activeDocId = null
      }
      this.emitChange()
      throw error
    } finally {
      releaseLease?.()
    }

    this.emitChange()
    return entry.view
  }

  async close(id: string): Promise<void> {
    if (this.destroyed) return

    const entry = this.docs.get(id)
    if (!entry) return

    // Invalidate any in-flight activate() that was awaiting ensureSession().
    this.operationEpoch++

    this.detachEntry(entry, {
      captureRestore: false,
      releaseSession: true,
      unregisterOwner: true,
    })

    this.docs.delete(id)
    this.lruOrder = this.lruOrder.filter((docId) => docId !== id)

    if (this.activeDocId === id) {
      this.activeDocId = null
    }

    this.emitChange()
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return

    this.destroyed = true
    this.operationEpoch++

    for (const entry of this.docs.values()) {
      this.detachEntry(entry, {
        captureRestore: false,
        releaseSession: true,
        unregisterOwner: true,
      })
    }

    this.docs.clear()
    this.lruOrder = []
    this.activeDocId = null
    this.snapshot = { activeDocId: null, openDocs: [] }
    this.listeners.clear()
  }

  rename(id: string, name: string): void {
    const entry = this.docs.get(id)
    if (!entry) return
    if (entry.name === name) return

    entry.name = name
    this.emitChange()
  }

  setModified(id: string, modified: boolean): void {
    const entry = this.docs.get(id)
    if (!entry) return
    if (entry.isModified === modified) return

    entry.isModified = modified
    this.emitChange()
  }

  getActiveDocId(): string | null {
    return this.activeDocId
  }

  getActiveView(): EditorView | null {
    if (!this.activeDocId) return null
    return this.docs.get(this.activeDocId)?.view ?? null
  }

  getOpenDocuments(): OpenDoc[] {
    return Array.from(this.docs.values()).map((entry) => ({
      id: entry.id,
      name: entry.name,
      isModified: entry.isModified,
    }))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ViewControllerSnapshot => {
    return this.snapshot
  }

  private detachOwnedView(id: string): void {
    const entry = this.docs.get(id)
    if (!entry) return

    this.detachEntry(entry, {
      captureRestore: true,
      releaseSession: true,
      unregisterOwner: true,
    })

    if (this.activeDocId === id) {
      this.activeDocId = null
    }

    this.emitChange()
  }

  private hideActiveIfNeeded(nextDocId: string): void {
    if (!this.activeDocId || this.activeDocId === nextDocId) return

    const active = this.docs.get(this.activeDocId)
    if (!active) return

    if (active.session) {
      clearCursorAwareness(active.session.awareness)
    }

    if (!active.containerEl) return

    active.containerEl.style.display = "none"
  }

  private ensureView(entry: DocEntry): void {
    if (entry.view && entry.containerEl) {
      return
    }

    const container = this.ensureContainer(entry)
    if (!container || !entry.session) {
      return
    }

    entry.view = this.createEditorViewFn({
      session: entry.session,
      container,
      restore: entry.restore,
    })

    entry.restore = null
  }

  private ensureContainer(entry: DocEntry): HTMLDivElement | null {
    if (entry.containerEl) {
      if (this.hostEl && entry.containerEl.parentElement !== this.hostEl) {
        this.hostEl.appendChild(entry.containerEl)
      }
      return entry.containerEl
    }

    if (!this.hostEl) {
      return null
    }

    const container = document.createElement("div")
    container.className = "editor-tab-container h-full min-h-0"
    container.style.display = "none"
    container.dataset.documentId = entry.id

    this.hostEl.appendChild(container)
    entry.containerEl = container
    return container
  }

  private showEntry(entry: DocEntry): void {
    if (!entry.containerEl || !entry.view) return

    entry.containerEl.style.display = ""
    // display:none -> visible requires a measure pass to fix viewport geometry.
    entry.view.requestMeasure()
    entry.view.focus()
    if (entry.session) {
      refreshCursorAwareness(entry.session.awareness, entry.view)
    }
  }

  private touchLru(id: string): void {
    this.lruOrder = this.lruOrder.filter((docId) => docId !== id)
    this.lruOrder.unshift(id)
  }

  private evictIfNeeded(): void {
    const liveCount = this.lruOrder.filter((id) => {
      const entry = this.docs.get(id)
      return entry?.view != null
    }).length

    if (liveCount <= this.maxLive) return

    const candidates = [...this.lruOrder]
      .reverse()
      .filter((id) => id !== this.activeDocId && this.docs.get(id)?.view != null)

    let toEvict = liveCount - this.maxLive
    for (const id of candidates) {
      if (toEvict <= 0) break

      const entry = this.docs.get(id)
      if (!entry || !entry.view) continue

      this.detachEntry(entry, {
        captureRestore: true,
        releaseSession: true,
        unregisterOwner: true,
      })
      toEvict--
    }
  }

  private detachEntry(entry: DocEntry, options: DetachOptions): void {
    if (options.unregisterOwner) {
      this.safeUnregisterOwner(entry.id)
    }

    if (entry.view) {
      if (entry.session) {
        clearCursorAwareness(entry.session.awareness)
      }

      if (options.captureRestore && entry.session) {
        entry.restore = this.captureRestoreState(entry)
      } else if (!options.captureRestore) {
        entry.restore = null
      }

      entry.view.destroy()
      entry.view = null
    }

    if (entry.containerEl) {
      entry.containerEl.remove()
      entry.containerEl = null
    }

    if (options.releaseSession) {
      if (entry.session) {
        entry.session.attachedViewCount = 0
      }
      this.safeReleaseSession(entry.id)
      entry.session = null
    }
  }

  private captureRestoreState(entry: DocEntry): ViewRestoreState {
    const view = entry.view
    const session = entry.session

    if (!view || !session) {
      return { scroll: null, selection: null }
    }

    const head = view.state.selection.main.head
    return {
      scroll: {
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      },
      selection: Y.createRelativePositionFromTypeIndex(session.ytext, head),
    }
  }

  private shouldAbort(epoch: number): boolean {
    return this.destroyed || epoch !== this.operationEpoch
  }

  private shouldAbortActivation(epoch: number, id: string, entry: DocEntry): boolean {
    if (this.shouldAbort(epoch) || this.sessionPool.isDestroyed) {
      return true
    }
    return this.docs.get(id) !== entry
  }

  private rollbackFailedActivation(entry: DocEntry): void {
    this.detachEntry(entry, {
      captureRestore: false,
      releaseSession: true,
      unregisterOwner: true,
    })
  }

  private safeReleaseSession(id: string): void {
    try {
      this.sessionPool.releaseSession(id)
    } catch {
      // pool may already be destroyed during teardown races
    }
  }

  private safeUnregisterOwner(id: string): void {
    try {
      this.sessionPool.unregisterViewOwner(id, this.surfaceId)
    } catch {
      // pool may already be destroyed during teardown races
    }
  }

  private emitChange(): void {
    this.snapshot = {
      activeDocId: this.activeDocId,
      openDocs: this.getOpenDocuments(),
    }

    for (const listener of this.listeners) {
      listener()
    }
  }
}
