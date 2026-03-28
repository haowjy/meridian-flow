import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWordCountExtension, type EditorContentAPI } from "./content-api"

describe("createWordCountExtension", () => {
  let container: HTMLDivElement
  let view: EditorView
  let getWordCount: () => number

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement("div")
    document.body.appendChild(container)

    const wc = createWordCountExtension()
    getWordCount = wc.getWordCount

    view = new EditorView({
      state: EditorState.create({
        doc: "hello world",
        extensions: [wc.extension],
      }),
      parent: container,
    })
  })

  afterEach(() => {
    view.destroy()
    container.remove()
    vi.useRealTimers()
  })

  it("returns 0 before any edits", () => {
    // No doc change event has fired yet
    expect(getWordCount()).toBe(0)
  })

  it("computes word count after debounce (500ms)", () => {
    // Trigger a doc change
    view.dispatch({
      changes: { from: 11, insert: " test" },
    })

    // Before debounce
    expect(getWordCount()).toBe(0)

    // After debounce
    vi.advanceTimersByTime(500)
    expect(getWordCount()).toBe(3) // "hello world test"
  })

  it("debounces rapid edits", () => {
    // Multiple rapid edits
    view.dispatch({ changes: { from: 11, insert: " a" } })
    vi.advanceTimersByTime(200)
    view.dispatch({ changes: { from: 13, insert: " b" } })
    vi.advanceTimersByTime(200)
    view.dispatch({ changes: { from: 15, insert: " c" } })

    // Only 400ms since last edit -- not yet counted
    vi.advanceTimersByTime(400)
    expect(getWordCount()).toBe(0)

    // 500ms since last edit
    vi.advanceTimersByTime(100)
    expect(getWordCount()).toBe(5) // "hello world a b c"
  })
})

describe("EditorContentAPI interface", () => {
  it("can be implemented with correct types", () => {
    // Type-level test: verify the interface is usable
    const api: EditorContentAPI = {
      getContent: () => "hello",
      getWordCount: () => 1,
      getCharCount: () => 5,
    }
    expect(api.getContent()).toBe("hello")
    expect(api.getWordCount()).toBe(1)
    expect(api.getCharCount()).toBe(5)
  })
})
