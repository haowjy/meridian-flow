import { useEffect, useImperativeHandle, useMemo, useRef } from "react"

import { Compartment, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"

import { cn } from "@/lib/utils"

import {
  createWordCountExtension,
  type EditorContentAPI,
} from "./content/content-api"
import {
  createEditorExtensions,
  createLocalEditorSession,
  livePreviewExtensions,
  placeholderExtension,
  readOnlyExtension,
  type EditorExtensionCompartments,
  type LocalEditorSession,
} from "./extensions"
import { EditorContextMenu } from "./interaction/EditorContextMenu"

export interface EditorProps {
  /** Y.Text to bind to. If not provided, creates a standalone local Y.Doc. */
  ytext?: Y.Text
  awareness?: Awareness
  undoManager?: Y.UndoManager
  readOnly?: boolean
  placeholder?: string
  livePreview?: boolean
  /** Extra CM6 extensions appended after built-ins */
  extensions?: Extension[]
  className?: string
  /** Ref to access the pull-based content API */
  contentApiRef?: React.RefObject<EditorContentAPI | null>
  /**
   * When ytext is not provided, Editor creates internal Yjs resources.
   * This ref exposes them so the parent can observe/read content.
   */
  sessionRef?: React.RefObject<{
    ydoc: Y.Doc
    ytext: Y.Text
    awareness: Awareness
    undoManager: Y.UndoManager
  } | null>
  /** Called once after the EditorView is created and assigned */
  onReady?: (view: EditorView) => void
}

export function Editor({
  ytext,
  awareness,
  undoManager,
  readOnly = false,
  placeholder,
  livePreview = true,
  extensions,
  className,
  contentApiRef,
  sessionRef,
  onReady,
}: EditorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onReadyRef = useRef(onReady)

  // Refs for initial values -- avoids stale closure in init effect
  // while keeping init effect dependency-free (runs once on mount)
  const initialReadOnlyRef = useRef(readOnly)
  const initialPlaceholderRef = useRef(placeholder)
  const initialLivePreviewRef = useRef(livePreview)
  const initialExtensionsRef = useRef(extensions ?? [])

  // Runtime-reconfigurable compartments. Only things that actually
  // toggle at runtime get compartments.
  const compartments = useMemo<EditorExtensionCompartments>(
    () => ({
      readOnly: new Compartment(),
      placeholder: new Compartment(),
      livePreview: new Compartment(),
      extra: new Compartment(),
    }),
    [],
  )

  // Pull-based content API: debounced word count, on-demand content access.
  // useMemo ensures the extension is created once and stable across renders.
  const wordCount = useMemo(() => createWordCountExtension(), [])

  // Expose the content API via ref
  useImperativeHandle(
    contentApiRef,
    () => ({
      getContent: () => viewRef.current?.state.doc.toString() ?? "",
      getWordCount: () => wordCount.getWordCount(),
      getCharCount: () => viewRef.current?.state.doc.length ?? 0,
    }),
    [wordCount],
  )

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  // Initialize the editor once on mount (or when ytext changes).
  // Always Yjs-native: uses yCollab + Y.UndoManager via createEditorExtensions.
  // When ytext/awareness/undoManager are provided, the caller owns Yjs resources.
  // When not provided, creates a local session (local Y.Doc, no persistence).
  useEffect(() => {
    if (!rootRef.current) {
      return
    }

    // Determine Yjs resources: use caller-provided or create local ones
    let localSession: LocalEditorSession | null = null
    let effectiveYtext: Y.Text
    let effectiveAwareness: Awareness
    let effectiveUndoManager: Y.UndoManager

    if (ytext && awareness && undoManager) {
      effectiveYtext = ytext
      effectiveAwareness = awareness
      effectiveUndoManager = undoManager
    } else {
      localSession = createLocalEditorSession()
      effectiveYtext = localSession.ytext
      effectiveAwareness = localSession.awareness
      effectiveUndoManager = localSession.undoManager
    }

    // Expose internal session through sessionRef when a local session was created
    if (sessionRef) {
      if (localSession) {
        sessionRef.current = {
          ydoc: localSession.ydoc,
          ytext: localSession.ytext,
          awareness: localSession.awareness,
          undoManager: localSession.undoManager,
        }
      } else {
        sessionRef.current = null
      }
    }

    const editorExtensions = createEditorExtensions({
      ytext: effectiveYtext,
      awareness: effectiveAwareness,
      undoManager: effectiveUndoManager,
      compartments,
      readOnly: initialReadOnlyRef.current,
      placeholder: initialPlaceholderRef.current,
      livePreview: initialLivePreviewRef.current,
      extra: initialExtensionsRef.current,
    })

    // Seed CM6 doc from Y.Text's current content. yCollab only observes
    // incremental changes — content inserted before its observer registers
    // (e.g., StandaloneEditor useMemo, SimulatedServer.addPeer) would be
    // invisible without this. When Y.Text is empty this is a no-op "".
    const view = new EditorView({
      doc: effectiveYtext.toString(),
      parent: rootRef.current,
      extensions: [
        ...editorExtensions,
        // Component-internal extensions (stable, no compartment needed)
        wordCount.extension,
      ],
    })

    viewRef.current = view
    onReadyRef.current?.(view)

    return () => {
      view.destroy()
      viewRef.current = null
      if (sessionRef) {
        sessionRef.current = null
      }
      localSession?.destroy()
    }
    // ytext is the primary dependency: when it changes, recreate the view
    // with the new Yjs resources. awareness and undoManager change together
    // with ytext in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness, undoManager, compartments, wordCount.extension])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: compartments.readOnly.reconfigure(readOnlyExtension(readOnly)),
    })
  }, [readOnly, compartments])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: compartments.placeholder.reconfigure(
        placeholderExtension(placeholder),
      ),
    })
  }, [placeholder, compartments])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: compartments.livePreview.reconfigure(
        livePreviewExtensions(livePreview),
      ),
    })
  }, [livePreview, compartments])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: compartments.extra.reconfigure(extensions ?? []),
    })
  }, [extensions, compartments])

  return (
    <div className={cn("h-full min-h-0", className)}>
      <div ref={rootRef} className="h-full min-h-0" />
      <EditorContextMenu viewRef={viewRef} />
    </div>
  )
}
