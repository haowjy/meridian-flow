// @vitest-environment jsdom
/**
 * The review's paint: where a hunk's green and red land in the editor, and the two risks that make the
 * review lie: a removal drawn at the wrong block boundary, and a review repainted from a stale base.
 */
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewRuntime } from "@/features/draft-review/review-runtime";
import {
  attachReviewRuntime,
  createReviewEditor,
  destroyReviewEditors,
  seedReviewBase,
} from "@/test-support/inline-review-editor";
import { inlineReviewClassNames } from "./decorations";

const projectors: ReviewRuntime[] = [];
function reviewing(base: string[], draft: string[]) {
  const { editor, doc } = createReviewEditor(draft);
  seedReviewBase(doc, base);
  const projector = attachReviewRuntime(editor, doc);
  projectors.push(projector);
  projector.projectNow();
  return { editor, doc, projector };
}

const added = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll(`.${inlineReviewClassNames.added}`)].map(
    (el) => el.textContent,
  );
const removals = (editor: Editor) => [
  ...editor.view.dom.querySelectorAll(`.${inlineReviewClassNames.removal}`),
];

afterEach(() => {
  for (const projector of projectors.splice(0)) projector.destroy();
  destroyReviewEditors();
  vi.useRealTimers();
});

describe("hunk placement", () => {
  it("paints inserted words green and the words they replaced red, ahead of the green", () => {
    const { editor } = reviewing(["Alpha beta gamma delta"], ["Alpha BETA gamma delta"]);
    expect(added(editor)).toEqual(["BETA"]);
    const [removal] = removals(editor);
    expect(removal?.textContent).toBe("beta");
    // Red then green: the widget is the green mark's previous sibling in the paragraph.
    expect(removal?.nextElementSibling?.classList.contains(inlineReviewClassNames.added)).toBe(
      true,
    );
  });

  it("draws a removed paragraph between its neighbours and a new one as a block mark", () => {
    const { editor } = reviewing(
      ["First paragraph stays.", "Second paragraph goes away.", "Third paragraph stays."],
      ["First paragraph stays.", "Third paragraph stays.", "A new closing paragraph."],
    );
    const children = [...editor.view.dom.children];
    const widget = children.find((el) =>
      el.classList.contains(inlineReviewClassNames.removalBlock),
    );
    expect(widget?.textContent).toBe("Second paragraph goes away.");
    // Between the first and the (surviving) third paragraph, not before or after the pair.
    expect(widget?.previousElementSibling?.textContent).toBe("First paragraph stays.");
    expect(widget?.nextElementSibling?.textContent).toBe("Third paragraph stays.");
    const block = editor.view.dom.querySelector(
      `p.${inlineReviewClassNames.added}.${inlineReviewClassNames.block}`,
    );
    expect(block?.textContent).toBe("A new closing paragraph.");
  });
});

describe("the base the review compares against", () => {
  it("repaints from the new base when review_base changes, with no edit in the draft", async () => {
    const { editor, doc } = reviewing(
      ["One two three four five six"],
      ["One TWO three four five six"],
    );
    expect(added(editor)).toEqual(["TWO"]);
    // A rebase advances the base to the writer's text: nothing is left to review.
    seedReviewBase(doc, ["One TWO three four five six"]);
    await Promise.resolve();
    expect(added(editor)).toEqual([]);
    expect(removals(editor)).toHaveLength(0);
    // And a later base that differs again repaints against that base, not the first one.
    seedReviewBase(doc, ["One two three four five SIX"]);
    await Promise.resolve();
    expect(added(editor)).toEqual(["TWO", "six"]);
  });
});

describe("recomputing while the writer types", () => {
  it("keeps the painted marks mapped through the edit and recomputes after the debounce", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { editor } = reviewing(["Alpha beta gamma delta"], ["Alpha BETA gamma delta"]);
    editor.commands.insertContentAt(1, "Oh ");
    expect(added(editor)).toEqual(["BETA"]);
    vi.advanceTimersByTime(119);
    expect(added(editor)).toEqual(["BETA"]);
    vi.advanceTimersByTime(2);
    expect(added(editor).join("")).toContain("Oh");
  });
});

describe("a repaint after the writer's edit", () => {
  it("keeps green on its words when focus repaints before the next projection", () => {
    // Risk: metadata repaints used the projection's old coordinates and threw away the mapped marks.
    const { editor } = reviewing(["The door is red."], ["The door is green."]);
    expect(added(editor)).toEqual(["green"]);
    editor.commands.insertContentAt(1, "PREFIX ");
    editor.commands.setReviewActiveChange("c0");
    expect(added(editor)).toEqual(["green"]);
  });
});
