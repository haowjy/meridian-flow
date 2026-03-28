import { type Root, createRoot } from "react-dom/client"
import { act } from "react"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"

import { type EditorContentAPI } from "./content/content-api"
import { Editor } from "./Editor"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

type SessionRefValue = {
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
}

interface MountedEditor {
  view: import("@codemirror/view").EditorView
  unmount(): Promise<void>
}

const mountedEditors: MountedEditor[] = []

async function mountEditor(props: React.ComponentProps<typeof Editor> = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  let unmounted = false
  let readyView: import("@codemirror/view").EditorView | null = null

  await act(async () => {
    root.render(<Editor {...props} onReady={(view) => (readyView = view)} />)
  })

  // onReady is set from an effect in Editor; give effects a tick to flush.
  for (let i = 0; i < 5 && !readyView; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }

  if (!readyView) {
    throw new Error("Editor did not become ready")
  }

  const mounted: MountedEditor = {
    view: readyView,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }

  mountedEditors.push(mounted)
  return mounted
}

afterEach(async () => {
  while (mountedEditors.length > 0) {
    const mounted = mountedEditors.pop()
    if (mounted) {
      await mounted.unmount()
    }
  }
  vi.useRealTimers()
})

describe("Editor component API", () => {
  it("mounts without ytext and creates a local session in sessionRef", async () => {
    const sessionRef = createRef<SessionRefValue | null>()

    await mountEditor({ sessionRef })

    expect(sessionRef.current).not.toBeNull()
    expect(sessionRef.current?.ydoc.isDestroyed).toBe(false)
  })

  it("mounts with provided ytext/awareness/undoManager and binds to them", async () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText("content")
    const awareness = new Awareness(ydoc)
    const undoManager = new Y.UndoManager(ytext)
    const sessionRef = createRef<SessionRefValue | null>()

    const mounted = await mountEditor({
      ytext,
      awareness,
      undoManager,
      sessionRef,
    })

    expect(sessionRef.current).toBeNull()

    await act(async () => {
      mounted.view.dispatch({ changes: { from: 0, insert: "provided text" } })
    })

    expect(ytext.toString()).toBe("provided text")

    await act(async () => {
      ytext.insert(ytext.length, " external")
    })

    expect(mounted.view.state.doc.toString()).toBe("provided text external")
    expect(ydoc.isDestroyed).toBe(false)

    undoManager.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("exposes contentApiRef with valid content, char count, and word count", async () => {
    vi.useFakeTimers()

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText("content")
    const awareness = new Awareness(ydoc)
    const undoManager = new Y.UndoManager(ytext)
    const contentApiRef = createRef<EditorContentAPI | null>()

    const mounted = await mountEditor({
      ytext,
      awareness,
      undoManager,
      contentApiRef,
    })

    expect(contentApiRef.current).not.toBeNull()

    await act(async () => {
      mounted.view.dispatch({ changes: { from: 0, insert: "hello world test" } })
    })

    expect(contentApiRef.current?.getContent()).toBe("hello world test")
    expect(contentApiRef.current?.getCharCount()).toBe(16)

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(contentApiRef.current?.getWordCount()).toBe(3)

    undoManager.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("updates ytext.toString() from typing without React state updates", async () => {
    const sessionRef = createRef<SessionRefValue | null>()

    const mounted = await mountEditor({ sessionRef })
    const localYtext = sessionRef.current?.ytext

    expect(localYtext).toBeDefined()
    expect(localYtext?.toString()).toBe("")

    await act(async () => {
      mounted.view.dispatch({ changes: { from: 0, insert: "typed in editor" } })
    })

    expect(localYtext?.toString()).toBe("typed in editor")
    expect(mounted.view.state.doc.toString()).toBe("typed in editor")
  })

  it("destroys locally created session resources on unmount", async () => {
    const sessionRef = createRef<SessionRefValue | null>()

    const mounted = await mountEditor({ sessionRef })
    const localDoc = sessionRef.current?.ydoc

    expect(localDoc).toBeDefined()
    expect(localDoc?.isDestroyed).toBe(false)

    await mounted.unmount()

    expect(sessionRef.current).toBeNull()
    expect(localDoc?.isDestroyed).toBe(true)
  })
})
