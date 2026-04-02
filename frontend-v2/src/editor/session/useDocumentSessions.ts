import { Compartment } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react"
import * as Y from "yjs"

import { createWordCountExtension } from "../content/content-api"
import {
  createEditorExtensions,
  type EditorExtensionCompartments,
} from "../extensions"

import type { DocSession, LocalPersistenceHealth } from "./doc-session"
import { useSessionPool } from "./session-pool-context"
import type { ConnectionState, DocSyncState, FrozenReason } from "./types"
import type { DocHandle, OpenDoc, ViewRestoreState } from "./view-controller"
import { ViewController } from "./view-controller"

export interface ActiveSessionSnapshot {
  syncState: DocSyncState
  connectionState: ConnectionState
  frozenReason: FrozenReason | null
  idbHealth: LocalPersistenceHealth
}

export interface UseDocumentSessionsResult {
  hostRef: React.RefCallback<HTMLDivElement>
  activeDocId: string | null
  openDocs: OpenDoc[]
  activeSessionSnapshot: ActiveSessionSnapshot | null
  activate(doc: DocHandle): void
  close(id: string): void
  rename(id: string, name: string): void
  setModified(id: string, modified: boolean): void
  getActiveView(): EditorView | null
  getSession(id: string): DocSession | null
}

interface DocumentSessionsSnapshot {
  activeDocId: string | null
  openDocs: OpenDoc[]
  activeSessionSnapshot: ActiveSessionSnapshot | null
}

const EMPTY_OPEN_DOCS: OpenDoc[] = []

function hasSameOpenDocs(a: OpenDoc[], b: OpenDoc[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id
      || a[i].name !== b[i].name
      || a[i].isModified !== b[i].isModified
    ) {
      return false
    }
  }
  return true
}

function hasSameSessionSnapshot(
  a: ActiveSessionSnapshot | null,
  b: ActiveSessionSnapshot | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.syncState === b.syncState
    && a.connectionState === b.connectionState
    && a.frozenReason === b.frozenReason
    && a.idbHealth.status === b.idbHealth.status
    && a.idbHealth.timedOut === b.idbHealth.timedOut
    && a.idbHealth.lastError === b.idbHealth.lastError
  )
}

export function useDocumentSessions(): UseDocumentSessionsResult {
  const sessionPool = useSessionPool()
  const surfaceId = useId()

  const createEditorView = useCallback(
    (args: {
      session: DocSession
      container: HTMLDivElement
      restore?: ViewRestoreState | null
    }): EditorView => {
      const compartments: EditorExtensionCompartments = {
        readOnly: new Compartment(),
        placeholder: new Compartment(),
        livePreview: new Compartment(),
        extra: new Compartment(),
      }
      // Keep the word-count listener mounted now; TabbedEditorShell plumbing for
      // reading the count from editor state will be wired in the full layout pass.
      const wordCount = createWordCountExtension()

      const view = new EditorView({
        doc: args.session.ytext.toString(),
        parent: args.container,
        extensions: [
          ...createEditorExtensions({
            ytext: args.session.ytext,
            awareness: args.session.awareness,
            undoManager: args.session.undoManager,
            compartments,
            readOnly: false,
            placeholder: "Start writing...",
            livePreview: true,
          }),
          wordCount.extension,
        ],
      })

      if (args.restore?.selection) {
        const absolutePos = Y.createAbsolutePositionFromRelativePosition(
          args.restore.selection,
          args.session.ydoc,
        )
        if (absolutePos?.type === args.session.ytext) {
          const anchor = Math.max(0, Math.min(absolutePos.index, view.state.doc.length))
          view.dispatch({ selection: { anchor } })
        }
      }

      if (args.restore?.scroll) {
        view.scrollDOM.scrollTop = args.restore.scroll.scrollTop
        view.scrollDOM.scrollLeft = args.restore.scroll.scrollLeft
      }

      return view
    },
    [],
  )

  const controller = useMemo(
    () =>
      new ViewController({
        surfaceId,
        sessionPool,
        createEditorView,
      }),
    [surfaceId, sessionPool, createEditorView],
  )

  useEffect(() => {
    return () => {
      void controller.destroy()
    }
  }, [controller])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let activeDocId: string | null = null
      let activeSession: DocSession | null = null
      let unsubscribeSession: (() => void) | null = null

      const attachActiveSessionListener = () => {
        const nextActiveDocId = controller.getActiveDocId()
        const nextActiveSession = nextActiveDocId
          ? sessionPool.getSession(nextActiveDocId)
          : null
        if (
          nextActiveDocId === activeDocId
          && nextActiveSession === activeSession
        ) {
          return
        }

        unsubscribeSession?.()
        unsubscribeSession = null
        activeDocId = nextActiveDocId
        activeSession = nextActiveSession

        if (!nextActiveSession) {
          return
        }

        unsubscribeSession = nextActiveSession.subscribe(onStoreChange)
      }

      attachActiveSessionListener()

      const unsubscribeController = controller.subscribe(() => {
        attachActiveSessionListener()
        onStoreChange()
      })

      const unsubscribeSessionPool = sessionPool.subscribe(() => {
        attachActiveSessionListener()
        onStoreChange()
      })

      return () => {
        unsubscribeController()
        unsubscribeSessionPool()
        unsubscribeSession?.()
      }
    },
    [controller, sessionPool],
  )

  const cachedSnapshotRef = useRef<DocumentSessionsSnapshot>({
    activeDocId: null,
    openDocs: EMPTY_OPEN_DOCS,
    activeSessionSnapshot: null,
  })

  const getSnapshot = useCallback((): DocumentSessionsSnapshot => {
    const controllerSnapshot = controller.getSnapshot()
    const activeDocId = controllerSnapshot.activeDocId

    let activeSessionSnapshot: ActiveSessionSnapshot | null = null
    if (activeDocId) {
      const session = sessionPool.getSession(activeDocId)
      if (session) {
        activeSessionSnapshot = {
          syncState: session.syncState,
          connectionState: session.connectionState,
          frozenReason: session.frozenReason,
          idbHealth: session.getIdbHealth(),
        }
      }
    }

    const nextSnapshot: DocumentSessionsSnapshot = {
      activeDocId,
      openDocs: controllerSnapshot.openDocs,
      activeSessionSnapshot,
    }

    const prev = cachedSnapshotRef.current
    if (
      prev.activeDocId === nextSnapshot.activeDocId
      && hasSameOpenDocs(prev.openDocs, nextSnapshot.openDocs)
      && hasSameSessionSnapshot(
        prev.activeSessionSnapshot,
        nextSnapshot.activeSessionSnapshot,
      )
    ) {
      return prev
    }

    cachedSnapshotRef.current = nextSnapshot
    return nextSnapshot
  }, [controller, sessionPool])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const hostRef = useCallback(
    (el: HTMLDivElement | null) => {
      controller.setHost(el)
    },
    [controller],
  )

  const activate = useCallback(
    (doc: DocHandle) => {
      void controller.activate(doc)
    },
    [controller],
  )

  const close = useCallback(
    (id: string) => {
      void controller.close(id)
    },
    [controller],
  )

  const rename = useCallback(
    (id: string, name: string) => {
      controller.rename(id, name)
    },
    [controller],
  )

  const setModified = useCallback(
    (id: string, modified: boolean) => {
      controller.setModified(id, modified)
    },
    [controller],
  )

  const getActiveView = useCallback(() => controller.getActiveView(), [controller])

  const getSession = useCallback(
    (id: string) => sessionPool.getSession(id),
    [sessionPool],
  )

  return {
    hostRef,
    activeDocId: snapshot.activeDocId,
    openDocs: snapshot.openDocs,
    activeSessionSnapshot: snapshot.activeSessionSnapshot,
    activate,
    close,
    rename,
    setModified,
    getActiveView,
    getSession,
  }
}
