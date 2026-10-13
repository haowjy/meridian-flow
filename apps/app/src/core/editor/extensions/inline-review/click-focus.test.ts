// @vitest-environment jsdom
/** A plain click in, beside or around a change focuses it, at the plugin seam. */

import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReviewEditor,
  destroyReviewEditors,
  model,
  operation,
  posOf,
  setModel,
  textHunk,
} from "../../../../test-support/inline-review-editor";
import { clickChanges, operationsNearPoint, resolveClickFocus } from "./click-focus";
import { getInlineReviewPluginState } from "./DraftInlineReviewExtension";

afterEach(destroyReviewEditors);

const PARAGRAPHS = [
  "I took my sword and walked alone to the old gate before dawn.",
  "Nothing here was changed at all.",
  "Later the rain came down on the far hills for hours.",
];

function click(editor: Editor, pos: number, init: Partial<MouseEventInit> = {}): boolean {
  const event = new MouseEvent("mouseup", { button: 0, ...init });
  return Boolean(editor.view.someProp("handleClick", (handle) => handle(editor.view, pos, event)));
}

function focused(editor: Editor): string | null {
  return getInlineReviewPluginState(editor.state)?.activeOperationId ?? null;
}

/** "my" replaced "his" (a removal widget then the insertion); "sword" and "gate" belong to the same change, "rain" to another. */
function paint(editor: Editor) {
  const at = (text: string) => {
    const from = posOf(editor, text);
    return { from, to: from + text.length };
  };
  setModel(
    editor,
    model(
      [operation("a1", "agent"), operation("a2", "agent")],
      [
        textHunk(editor, "h1", ["a1"], at("my"), { deletedText: "his" }),
        textHunk(editor, "h2", ["a1"], at("gate")),
        textHunk(editor, "h3", ["a2"], at("rain")),
      ],
    ),
  );
}

describe("click focus", () => {
  it("focuses the change at the junction of a struck word and its replacement", () => {
    const { editor } = createReviewEditor(PARAGRAPHS);
    paint(editor);
    click(editor, posOf(editor, "my"));
    expect(focused(editor)).toBe("a1");
  });

  it("focuses a change from the unmarked words between its marks", () => {
    const { editor } = createReviewEditor(PARAGRAPHS);
    paint(editor);
    click(editor, posOf(editor, "walked"));
    expect(focused(editor)).toBe("a1");
  });

  it("focuses a change when the caret lands in a word beside one of its marks", () => {
    const { editor } = createReviewEditor(PARAGRAPHS);
    paint(editor);
    // "the far hills" is in the rain paragraph; "Later" is outside the mark but in its block.
    click(editor, posOf(editor, "hills") + 2);
    expect(focused(editor)).toBe("a2");
  });

  it("leaves focus alone for a block without changes, and never clears it", () => {
    const { editor } = createReviewEditor(PARAGRAPHS);
    paint(editor);
    editor.commands.setInlineReviewActiveOperation("a2");
    click(editor, posOf(editor, "Nothing") + 3);
    expect(focused(editor)).toBe("a2");
  });

  it("ignores modified clicks and hidden marks", () => {
    const { editor } = createReviewEditor(PARAGRAPHS);
    paint(editor);
    click(editor, posOf(editor, "my"), { shiftKey: true });
    expect(focused(editor)).toBeNull();
    editor.commands.setInlineReviewMarksVisible(false);
    click(editor, posOf(editor, "my"));
    expect(focused(editor)).toBeNull();
  });
});

describe("click candidates", () => {
  it("pick the change whose nearest mark is closest when extents overlap", () => {
    const { editor } = createReviewEditor(PARAGRAPHS);
    const at = (text: string) => {
      const from = posOf(editor, text);
      return { from, to: from + text.length };
    };
    // a1 spans "took" … "alone"; a2 ("sword" … "walked") sits inside it.
    setModel(
      editor,
      model(
        [operation("a1", "agent"), operation("a2", "agent")],
        [
          textHunk(editor, "h1", ["a1"], at("took")),
          textHunk(editor, "h2", ["a1"], at("alone")),
          textHunk(editor, "h3", ["a2"], at("sword")),
          textHunk(editor, "h4", ["a2"], at("walked")),
        ],
      ),
    );
    const geometry = getInlineReviewPluginState(editor.state)?.geometry;
    if (!geometry) throw new Error("no geometry");
    const changes = clickChanges(geometry);
    const probe = (pos: number) => ({
      pos,
      word: null,
      block: null,
      nearOperationIds: new Set<string>(),
    });
    expect(
      resolveClickFocus(changes, probe(posOf(editor, "and"))).map((c) => c.operationId),
    ).toEqual(["a2", "a1"]);
    expect(
      resolveClickFocus(changes, probe(posOf(editor, "alone"))).map((c) => c.operationId),
    ).toEqual(["a1"]);
  });

  it("count a near miss within the slop of a painted element", () => {
    const root = document.createElement("div");
    const mark = document.createElement("span");
    mark.setAttribute("data-review-operations", "a1 a9");
    mark.getClientRects = () =>
      [{ left: 100, right: 140, top: 10, bottom: 30 }] as unknown as DOMRectList;
    root.append(mark);
    expect([...operationsNearPoint(root, "data-review-operations", 148, 20)].sort()).toEqual([
      "a1",
      "a9",
    ]);
    expect(operationsNearPoint(root, "data-review-operations", 160, 20).size).toBe(0);
    expect(
      resolveClickFocus(
        [{ operationId: "a1", operationIds: new Set(["a1"]), spans: [{ from: 5, to: 8 }] }],
        { pos: 30, word: null, block: null, nearOperationIds: new Set(["a1"]) },
      ),
    ).toEqual([{ operationId: "a1", tier: 2, distance: 22 }]);
  });
});
