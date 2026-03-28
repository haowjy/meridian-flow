import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { focusChange, focusState, focusTracker } from "./focus-state"
import { revealState } from "./reveal-state"

describe("focusState StateField", () => {
  it("initializes to false", () => {
    const state = EditorState.create({
      doc: "",
      extensions: [focusState, revealState],
    })
    expect(state.field(focusState)).toBe(false)
  })

  it("updates to true on focusChange(true) effect", () => {
    const state = EditorState.create({
      doc: "",
      extensions: [focusState, revealState],
    })

    const tr = state.update({ effects: focusChange.of(true) })
    expect(tr.state.field(focusState)).toBe(true)
  })

  it("updates to false on focusChange(false) effect", () => {
    const state = EditorState.create({
      doc: "",
      extensions: [focusState, revealState],
    })

    // First set to true
    const tr1 = state.update({ effects: focusChange.of(true) })
    // Then set to false
    const tr2 = tr1.state.update({ effects: focusChange.of(false) })
    expect(tr2.state.field(focusState)).toBe(false)
  })

  it("preserves value when no focusChange effect in transaction", () => {
    const state = EditorState.create({
      doc: "hello",
      extensions: [focusState, revealState],
    })

    const tr1 = state.update({ effects: focusChange.of(true) })
    // An unrelated edit
    const tr2 = tr1.state.update({
      changes: { from: 5, insert: " world" },
    })
    expect(tr2.state.field(focusState)).toBe(true)
  })
})

describe("focusTracker domEventHandlers", () => {
  let container: HTMLDivElement
  let view: EditorView

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement("div")
    document.body.appendChild(container)

    view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [focusState, revealState, focusTracker],
      }),
      parent: container,
    })
  })

  afterEach(() => {
    view.destroy()
    container.remove()
    vi.useRealTimers()
  })

  it("dispatches focusChange(true) on focus event", () => {
    // Simulate focus
    view.contentDOM.dispatchEvent(new FocusEvent("focus"))
    expect(view.state.field(focusState)).toBe(true)
  })

  it("dispatches focusChange(false) on blur after 50ms debounce", () => {
    // Focus first
    view.contentDOM.dispatchEvent(new FocusEvent("focus"))
    expect(view.state.field(focusState)).toBe(true)

    // Blur
    view.contentDOM.dispatchEvent(new FocusEvent("blur"))
    // Should still be true (debounced)
    expect(view.state.field(focusState)).toBe(true)

    // Advance past debounce
    vi.advanceTimersByTime(50)
    expect(view.state.field(focusState)).toBe(false)
  })

  it("cancels blur debounce if focus returns within 50ms", () => {
    // Focus
    view.contentDOM.dispatchEvent(new FocusEvent("focus"))
    expect(view.state.field(focusState)).toBe(true)

    // Blur (starts debounce)
    view.contentDOM.dispatchEvent(new FocusEvent("blur"))

    // Focus again before debounce expires
    vi.advanceTimersByTime(30)
    view.contentDOM.dispatchEvent(new FocusEvent("focus"))

    // Advance past original debounce window
    vi.advanceTimersByTime(30)
    // Should still be focused -- blur was cancelled
    expect(view.state.field(focusState)).toBe(true)
  })
})
