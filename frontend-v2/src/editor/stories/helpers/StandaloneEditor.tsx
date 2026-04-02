/**
 * Standalone editor for Storybook demos (no backend, no collab).
 *
 * Creates its own local Yjs session, seeds initial content into Y.Text
 * once on creation, and treats Yjs as the source of truth. No React
 * state mediation — content lives entirely in Y.Text.
 */

import { useEffect, useMemo } from "react"

import { Editor } from "../../Editor"
import { EditorShell } from "../../components/EditorShell"
import { createLocalEditorSession } from "../../extensions"

export interface StandaloneEditorProps {
  initialContent: string
  livePreview?: boolean
  /** Show the EditorShell (with mode tabs) instead of bare editor */
  withShell?: boolean
  className?: string
}

export function StandaloneEditor({
  initialContent,
  livePreview = true,
  withShell = false,
  className,
}: StandaloneEditorProps) {
  // Create a local Yjs session once and seed initial content.
  // useMemo (not useEffect) so the session is available on first render.
  const session = useMemo(() => {
    const s = createLocalEditorSession()
    if (initialContent) {
      s.ytext.insert(0, initialContent)
    }
    return s
    // initialContent is intentionally captured only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clean up Yjs resources on unmount
  useEffect(() => {
    return () => session.destroy()
  }, [session])

  if (withShell) {
    return (
      <div className={className ?? "mx-auto h-[700px] w-full max-w-5xl"}>
        <EditorShell
          ytext={session.ytext}
          awareness={session.awareness}
          undoManager={session.undoManager}
          placeholder="Start writing..."
        />
      </div>
    )
  }

  return (
    <div className={className ?? "mx-auto h-[700px] w-full max-w-5xl"}>
      <Editor
        ytext={session.ytext}
        awareness={session.awareness}
        undoManager={session.undoManager}
        livePreview={livePreview}
        placeholder="Start writing..."
      />
    </div>
  )
}
