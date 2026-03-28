import { EditorSelection, EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"

import { concealElement, revealElement, revealState } from "./reveal-state"

describe("revealState StateField", () => {
  function createState(doc = "hello world") {
    return EditorState.create({
      doc,
      extensions: [revealState],
    })
  }

  it("initializes to empty set", () => {
    const state = createState()
    expect(state.field(revealState).size).toBe(0)
  })

  it("adds range on revealElement effect", () => {
    const state = createState()
    const tr = state.update({
      effects: revealElement.of({ from: 0, to: 5 }),
    })
    const revealed = tr.state.field(revealState)
    expect(revealed.size).toBe(1)
    expect(revealed.has("0-5")).toBe(true)
  })

  it("removes range on concealElement effect", () => {
    const state = createState()
    const tr1 = state.update({
      effects: revealElement.of({ from: 0, to: 5 }),
    })
    const tr2 = tr1.state.update({
      effects: concealElement.of({ from: 0, to: 5 }),
    })
    expect(tr2.state.field(revealState).size).toBe(0)
  })

  it("tracks multiple revealed ranges", () => {
    const state = createState("hello world test")
    const tr = state.update({
      effects: [
        revealElement.of({ from: 0, to: 5 }),
        revealElement.of({ from: 6, to: 11 }),
      ],
    })
    const revealed = tr.state.field(revealState)
    expect(revealed.size).toBe(2)
    expect(revealed.has("0-5")).toBe(true)
    expect(revealed.has("6-11")).toBe(true)
  })

  it("maps ranges through document changes", () => {
    const state = createState("hello world")
    const tr1 = state.update({
      effects: revealElement.of({ from: 6, to: 11 }),
    })

    // Insert "XY" at position 0, shifting everything right by 2
    const tr2 = tr1.state.update({
      changes: { from: 0, insert: "XY" },
    })
    const revealed = tr2.state.field(revealState)
    expect(revealed.size).toBe(1)
    // "world" shifted from 6-11 to 8-13
    expect(revealed.has("8-13")).toBe(true)
  })

  it("auto-conceals when selection moves outside revealed range", () => {
    const state = createState("hello world")
    // Reveal "hello"
    const tr1 = state.update({
      effects: revealElement.of({ from: 0, to: 5 }),
    })

    // Move cursor outside the revealed range
    const tr2 = tr1.state.update({
      selection: EditorSelection.cursor(8),
    })
    expect(tr2.state.field(revealState).size).toBe(0)
  })

  it("keeps reveal when selection stays inside revealed range", () => {
    const state = createState("hello world")
    // Reveal "hello"
    const tr1 = state.update({
      effects: revealElement.of({ from: 0, to: 5 }),
    })

    // Move cursor inside the revealed range
    const tr2 = tr1.state.update({
      selection: EditorSelection.cursor(3),
    })
    expect(tr2.state.field(revealState).size).toBe(1)
    expect(tr2.state.field(revealState).has("0-5")).toBe(true)
  })

  it("does not auto-conceal on doc changes without selection set", () => {
    const state = createState("hello world")
    const tr1 = state.update({
      effects: revealElement.of({ from: 0, to: 5 }),
    })

    // Edit that doesn't affect the revealed range (append text)
    const tr2 = tr1.state.update({
      changes: { from: 11, insert: " extra" },
    })
    expect(tr2.state.field(revealState).size).toBe(1)
  })

  it("does NOT clear on blur (no focusChange interaction)", () => {
    // revealState is independent of focus -- it persists across blur
    const state = createState("hello world")
    const tr1 = state.update({
      effects: revealElement.of({ from: 0, to: 5 }),
    })
    // Just a regular transaction with no selection change
    const tr2 = tr1.state.update({})
    expect(tr2.state.field(revealState).size).toBe(1)
  })
})
