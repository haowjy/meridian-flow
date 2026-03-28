import { EditorSelection, EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"

import { selectionIntersectsRange } from "./cursor-utils"

describe("selectionIntersectsRange", () => {
  function createState(doc: string, cursor: number): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
    })
  }

  function createStateWithSelection(
    doc: string,
    anchor: number,
    head: number,
  ): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.range(anchor, head),
    })
  }

  describe("empty cursor (no selection)", () => {
    it("returns true when cursor is inside range", () => {
      const state = createState("hello world", 3)
      expect(selectionIntersectsRange(state, 0, 5)).toBe(true)
    })

    it("returns true when cursor is at range start", () => {
      const state = createState("hello world", 2)
      expect(selectionIntersectsRange(state, 2, 5)).toBe(true)
    })

    it("returns true when cursor is at range end", () => {
      const state = createState("hello world", 5)
      expect(selectionIntersectsRange(state, 2, 5)).toBe(true)
    })

    it("returns false when cursor is outside range", () => {
      const state = createState("hello world", 8)
      expect(selectionIntersectsRange(state, 0, 5)).toBe(false)
    })

    it("returns false when cursor is one before range start (no padding)", () => {
      const state = createState("hello world", 1)
      expect(selectionIntersectsRange(state, 2, 5)).toBe(false)
    })
  })

  describe("with padding", () => {
    it("returns true when cursor is within padding of range start", () => {
      const state = createState("hello world", 1)
      expect(selectionIntersectsRange(state, 2, 5, 1)).toBe(true)
    })

    it("returns true when cursor is within padding of range end", () => {
      const state = createState("hello world", 6)
      expect(selectionIntersectsRange(state, 2, 5, 1)).toBe(true)
    })

    it("returns false when cursor is beyond padding", () => {
      const state = createState("hello world", 0)
      expect(selectionIntersectsRange(state, 2, 5, 1)).toBe(false)
    })
  })

  describe("non-empty selection", () => {
    it("returns true when selection overlaps range", () => {
      const state = createStateWithSelection("hello world", 3, 8)
      expect(selectionIntersectsRange(state, 0, 5)).toBe(true)
    })

    it("returns true when selection fully contains range", () => {
      const state = createStateWithSelection("hello world", 0, 11)
      expect(selectionIntersectsRange(state, 2, 5)).toBe(true)
    })

    it("returns true when range fully contains selection", () => {
      const state = createStateWithSelection("hello world", 2, 4)
      expect(selectionIntersectsRange(state, 0, 5)).toBe(true)
    })

    it("returns false when selection is entirely before range", () => {
      const state = createStateWithSelection("hello world", 0, 1)
      expect(selectionIntersectsRange(state, 3, 5)).toBe(false)
    })

    it("returns false when selection is entirely after range", () => {
      const state = createStateWithSelection("hello world", 8, 11)
      expect(selectionIntersectsRange(state, 0, 5)).toBe(false)
    })
  })

  describe("multi-cursor", () => {
    it("returns true when any cursor intersects range", () => {
      const state = EditorState.create({
        doc: "hello world test",
        selection: EditorSelection.create(
          [EditorSelection.cursor(0), EditorSelection.cursor(8)],
          1, // mainIndex -- which cursor is primary
        ),
      })
      // Cursor at 8 intersects range 6-11
      expect(selectionIntersectsRange(state, 6, 11)).toBe(true)
    })
  })
})
