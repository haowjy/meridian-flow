import { useCallback, useRef, useState } from "react"

import { cn } from "@/lib/utils"

import type { EditorContentAPI } from "./content/content-api"
import { EditorModeTabs, type EditorMode } from "./EditorModeTabs"
import type { OpenDoc } from "./session/view-controller"
import { TabBar } from "./tabs/TabBar"
import { TitleHeader } from "./title-header/TitleHeader"
import type { CollabConnectionState } from "./title-header/ConnectionStatus"

export interface TabbedEditorShellProps {
  /** Open documents from useDocumentSessions() */
  openDocs?: OpenDoc[]
  /** Active document ID from useDocumentSessions() */
  activeDocId?: string | null
  /** Called when user activates a doc */
  onActivateDoc?: (documentId: string) => void
  /** Called when user closes a doc */
  onCloseDoc?: (documentId: string) => void
  /** Active document name for the title header */
  documentName: string
  /** Called when the user renames the document */
  onRename?: (newName: string) => void
  /** Connection status */
  connectionState?: CollabConnectionState
  /** Word count from EditorContentAPI */
  wordCount?: number
  /** Selection word count */
  selectionWordCount?: number
  /** Last saved time (relative string) */
  lastSaved?: string
  /** Ref to the EditorContentAPI for export */
  contentApiRef?: React.RefObject<EditorContentAPI | null>
  /** Direct getContent callback - takes precedence over contentApiRef */
  getContent?: () => string
  /** Editor mode (preview/source) */
  mode?: EditorMode
  onModeChange?: (mode: EditorMode) => void
  className?: string
  /** Children: ViewController host container */
  children?: React.ReactNode
}

/**
 * Multi-tab editor shell composing tab bar, title header, and editor container.
 *
 * The editor area is provided as `children` -- typically the host div
 * managed by `useDocumentSessions`. This shell just handles the chrome.
 */
export function TabbedEditorShell({
  openDocs,
  activeDocId,
  onActivateDoc,
  onCloseDoc,
  documentName,
  onRename,
  connectionState = "disconnected",
  wordCount = 0,
  selectionWordCount = 0,
  lastSaved,
  contentApiRef,
  getContent: getContentProp,
  mode,
  onModeChange,
  className,
  children,
}: TabbedEditorShellProps) {
  const resolvedOpenDocs = openDocs ?? []
  const resolvedActiveDocId = activeDocId ?? null
  const handleActivateDoc = onActivateDoc ?? (() => {})
  const handleCloseDoc = onCloseDoc ?? (() => {})

  const [internalMode, setInternalMode] = useState<EditorMode>("preview")
  const resolvedMode = mode ?? internalMode
  const contentApiRefLocal = useRef<EditorContentAPI | null>(null)
  const effectiveRef = contentApiRef ?? contentApiRefLocal

  const handleModeChange = useCallback(
    (nextMode: EditorMode) => {
      if (mode === undefined) {
        setInternalMode(nextMode)
      }
      onModeChange?.(nextMode)
    },
    [mode, onModeChange],
  )

  // Direct getContent prop takes precedence over contentApiRef
  const getContent = useCallback(() => {
    if (getContentProp) return getContentProp()
    return effectiveRef.current?.getContent() ?? ""
  }, [getContentProp, effectiveRef])

  return (
    <section
      className={cn(
        "flex h-full min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border/80",
        "bg-background/40 shadow-[0_10px_30px_oklch(0_0_0/0.06)]",
        className,
      )}
    >
      {/* Tab bar */}
      <TabBar
        tabs={resolvedOpenDocs}
        activeTabId={resolvedActiveDocId}
        onSwitch={handleActivateDoc}
        onClose={handleCloseDoc}
      />

      {/* Title header */}
      <TitleHeader
        documentName={documentName}
        onRename={onRename}
        connectionState={connectionState}
        wordCount={wordCount}
        selectionWordCount={selectionWordCount}
        lastSaved={lastSaved}
        getContent={getContent}
      />

      {/* Mode tabs */}
      <div className="flex items-center justify-between border-b border-border/80 px-4 py-2">
        <EditorModeTabs mode={resolvedMode} onModeChange={handleModeChange} />
      </div>

      {/* Editor container managed by useDocumentSessions */}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}
