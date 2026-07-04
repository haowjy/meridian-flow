/** Extension integration tests for optimistic inline-review overlays. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";

import {
  buildInlineReviewPlugin,
  coalesceRanges,
  draftInlineReviewPluginKey,
  getInlineReviewPluginState,
} from "./DraftInlineReviewExtension";

function createReviewState(): EditorState {
  const schema = buildDocumentSchema();
  return EditorState.create({
    schema,
    doc: schema.node("doc", null, [schema.node("paragraph", null)]),
    plugins: [buildInlineReviewPlugin({ initialModel: null })],
  });
}

function apply(state: EditorState, configure: (tr: Transaction) => Transaction): EditorState {
  return state.apply(configure(state.tr));
}

describe("coalesceRanges", () => {
  it("merges adjacent single-char ranges (three keystrokes → one range)", () => {
    const merged = coalesceRanges([
      { from: 10, to: 11 },
      { from: 11, to: 12 },
      { from: 12, to: 13 },
    ]);
    expect(merged).toEqual([{ from: 10, to: 13 }]);
  });

  it("merges overlapping ranges", () => {
    const merged = coalesceRanges([
      { from: 5, to: 12 },
      { from: 10, to: 20 },
    ]);
    expect(merged).toEqual([{ from: 5, to: 20 }]);
  });

  it("keeps disjoint ranges separate", () => {
    const merged = coalesceRanges([
      { from: 5, to: 8 },
      { from: 20, to: 25 },
    ]);
    expect(merged).toEqual([
      { from: 5, to: 8 },
      { from: 20, to: 25 },
    ]);
  });

  it("sorts input before merging", () => {
    const merged = coalesceRanges([
      { from: 30, to: 35 },
      { from: 10, to: 15 },
      { from: 15, to: 20 },
    ]);
    expect(merged).toEqual([
      { from: 10, to: 20 },
      { from: 30, to: 35 },
    ]);
  });

  it("drops empty (from >= to) ranges", () => {
    const merged = coalesceRanges([
      { from: 5, to: 5 },
      { from: 10, to: 8 },
      { from: 20, to: 25 },
    ]);
    expect(merged).toEqual([{ from: 20, to: 25 }]);
  });

  it("returns [] for empty input", () => {
    expect(coalesceRanges([])).toEqual([]);
  });
});

describe("DraftInlineReviewExtension plugin", () => {
  it("tracks only local typing as optimistic writer overlay and clears it on set-model", () => {
    let state = createReviewState();

    state = apply(state, (tr) => tr.insertText("abc", 1));
    expect(getInlineReviewPluginState(state)?.optimisticRanges).toEqual([{ from: 1, to: 4 }]);
    expect(getInlineReviewPluginState(state)?.optimisticDecorations.find()).toHaveLength(1);

    state = apply(state, (tr) => {
      tr.insertText(" remote", 4);
      tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
      return tr;
    });
    expect(getInlineReviewPluginState(state)?.optimisticRanges).toEqual([{ from: 1, to: 4 }]);

    state = apply(state, (tr) => {
      tr.setMeta(draftInlineReviewPluginKey, { kind: "set-model", model: null });
      tr.setMeta("addToHistory", false);
      return tr;
    });
    expect(getInlineReviewPluginState(state)?.optimisticRanges).toEqual([]);
    expect(getInlineReviewPluginState(state)?.optimisticDecorations.find()).toHaveLength(0);
  });
});
