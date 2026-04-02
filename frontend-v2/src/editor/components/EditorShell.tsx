import { useCallback, useState } from "react"

import { cn } from "@/lib/utils"

import { Editor, type EditorProps } from "../Editor"
import { EditorModeTabs, type EditorMode } from "./EditorModeTabs"

// --- Single-document shell (original) ---

export interface EditorShellProps extends Omit<EditorProps, "className" | "livePreview"> {
  mode?: EditorMode
  onModeChange?: (mode: EditorMode) => void
  className?: string
}

export function EditorShell({
  ytext,
  awareness,
  undoManager,
  readOnly = false,
  placeholder,
  extensions,
  contentApiRef,
  sessionRef,
  onReady,
  mode,
  onModeChange,
  className,
}: EditorShellProps) {
  const [internalMode, setInternalMode] = useState<EditorMode>("preview")
  const resolvedMode = mode ?? internalMode

  const handleModeChange = useCallback(
    (nextMode: EditorMode) => {
      if (mode === undefined) {
        setInternalMode(nextMode)
      }
      onModeChange?.(nextMode)
    },
    [mode, onModeChange]
  )

  return (
    <section
      className={cn(
        "flex h-full min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border/80",
        "bg-background/40 shadow-[0_10px_30px_oklch(0_0_0/0.06)]",
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-border/80 px-4 py-3">
        <EditorModeTabs mode={resolvedMode} onModeChange={handleModeChange} />
      </div>

      <div className="min-h-0 flex-1">
        <Editor
          ytext={ytext}
          awareness={awareness}
          undoManager={undoManager}
          readOnly={readOnly}
          placeholder={placeholder}
          extensions={extensions}
          contentApiRef={contentApiRef}
          sessionRef={sessionRef}
          onReady={onReady}
          livePreview={resolvedMode === "preview"}
          className="h-full"
        />
      </div>
    </section>
  )
}
