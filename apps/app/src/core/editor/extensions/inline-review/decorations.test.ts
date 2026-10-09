// @vitest-environment jsdom
/**
 * Decoration model for in-manuscript draft review: each kind of change, the
 * removal widget and its fold, focus, and hidden marks, driven through a real
 * collaborative TipTap editor so anchors resolve exactly as they do in review.
 */

import type { ReviewDeletedSpan } from "@meridian/contracts/drafts";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

import {
  createReviewEditor,
  destroyReviewEditors,
  model,
  operation,
  posOf,
  rel,
  setModel,
  span,
  textHunk,
} from "../../../../test-support/inline-review-editor";
import { PROSEMIRROR_FRAGMENT_NAME } from "../../schema";
import { type InlineReviewModel, unattributedHunkKey } from "./model";
import { REMOVAL_COLLAPSE_CHARS } from "./removal-widget";

/** Every anchor the editor resolves goes through here; counted to prove what a repaint does not redo. */
const resolutions = vi.hoisted(() => ({ count: 0 }));
vi.mock("@tiptap/y-tiptap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/y-tiptap")>();
  return {
    ...actual,
    relativePositionToAbsolutePosition: (
      ...args: Parameters<typeof actual.relativePositionToAbsolutePosition>
    ) => {
      resolutions.count += 1;
      return actual.relativePositionToAbsolutePosition(...args);
    },
  };
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  destroyReviewEditors();
  vi.unstubAllGlobals();
});

function marked(editor: Editor, className: string): string[] {
  return [...editor.view.dom.querySelectorAll(`.${className}`)].map((el) => el.textContent ?? "");
}

function removals(editor: Editor): HTMLElement[] {
  return [...editor.view.dom.querySelectorAll<HTMLElement>(".meridian-review-removal")];
}

describe("insertion marks", () => {
  it("paints an AI insertion green and a writer insertion gold", () => {
    const { editor } = createReviewEditor(["Elder Mo raised one withered hand and wept."]);
    const withered = posOf(editor, "one withered");
    const wept = posOf(editor, "wept");
    setModel(
      editor,
      model(
        [operation("a1", "agent"), operation("w1", "writer")],
        [
          textHunk(
            editor,
            "h1",
            ["a1"],
            { from: withered, to: withered + 12 },
            {
              spans: [span(editor, "a1", withered, withered + 12)],
            },
          ),
          textHunk(
            editor,
            "h2",
            ["w1"],
            { from: wept, to: wept + 4 },
            {
              spans: [span(editor, "w1", wept, wept + 4)],
            },
          ),
        ],
      ),
    );
    expect(marked(editor, "meridian-review-added")).toEqual(["one withered"]);
    expect(marked(editor, "meridian-review-writer")).toEqual(["wept"]);
  });

  it("paints writer text typed inside an AI change gold inside green", () => {
    const { editor } = createReviewEditor(["The third seal cracked, spilling bone-white light."]);
    const start = posOf(editor, "The third");
    const bone = posOf(editor, "bone-white");
    const end = posOf(editor, ".") + 1;
    setModel(
      editor,
      model(
        [operation("a1", "agent", "closure:a1+w1"), operation("w1", "writer", "closure:a1+w1")],
        [
          // Ordinary writer typing inside AI text: the server does not flag it.
          textHunk(
            editor,
            "h1",
            ["a1", "w1"],
            { from: start, to: end },
            {
              spans: [
                span(editor, "a1", start, bone),
                span(editor, "w1", bone, bone + 10),
                span(editor, "a1", bone + 10, end),
              ],
            },
          ),
        ],
      ),
    );
    expect(marked(editor, "meridian-review-writer")).toEqual(["bone-white"]);
    expect(marked(editor, "meridian-review-added").join("")).toBe(
      "The third seal cracked, spilling  light.",
    );
    expect(marked(editor, "meridian-review-merged")).toEqual([]);
  });

  it("paints a hunk the server flags as a merge artifact as one dashed grey region, whatever its author runs", () => {
    const { editor } = createReviewEditor(["The outer disciples fell back to their knees."]);
    const start = posOf(editor, "fell");
    const end = posOf(editor, ".");
    // Two author runs only: a run-counting heuristic would have called this readable.
    const cut = start + 9;
    setModel(
      editor,
      model(
        [operation("a1", "agent", "closure:m"), operation("w1", "writer", "closure:m")],
        [
          textHunk(
            editor,
            "h1",
            ["a1", "w1"],
            { from: start, to: end },
            {
              mergeArtifact: true,
              spans: [span(editor, "a1", start, cut), span(editor, "w1", cut, end)],
            },
          ),
        ],
      ),
    );
    expect(marked(editor, "meridian-review-merged")).toEqual(["fell back to their knees"]);
    expect(marked(editor, "meridian-review-added")).toEqual([]);
    expect(marked(editor, "meridian-review-writer")).toEqual([]);
  });

  it("marks what the writer types at once, before any refetch", () => {
    const { editor } = createReviewEditor(["Lin Feng counted breaths."]);
    setModel(editor, model([], []));
    const at = posOf(editor, "breaths");
    editor.chain().setTextSelection(at).insertContent("slow").run();
    editor
      .chain()
      .setTextSelection(at + 4)
      .insertContent("er ")
      .run();
    // Two keystroke batches that touch become one run.
    expect(marked(editor, "meridian-review-writer")).toEqual(["slower "]);
    // The refetched model replaces the optimistic run.
    setModel(editor, model([], []));
    expect(marked(editor, "meridian-review-writer")).toEqual([]);
  });
});

describe("block insertions", () => {
  /** A hunk over the whole top-level paragraph that starts at `needle`, the way the server anchors one. */
  function blockInsertion(
    editor: Editor,
    needle: string,
    hunkId: string,
    operationIds: string[],
    flags: { unclassified?: boolean; mergeArtifact?: boolean } = {},
  ): InlineReviewModel["hunks"][number] {
    const start = posOf(editor, needle) - 1;
    const node = editor.state.doc.nodeAt(start);
    return {
      kind: "block",
      hunkId,
      operationIds,
      relStart: rel(editor, start),
      relEnd: rel(editor, start + (node?.nodeSize ?? 0)),
      insertedBlock: { type: "paragraph", display: needle },
      ...flags,
    };
  }

  it("paints an AI block green and a writer block gold", () => {
    const { editor } = createReviewEditor(["Before.", "Agent block.", "Writer block."]);
    setModel(
      editor,
      model(
        [operation("a1", "agent"), operation("w1", "writer")],
        [
          blockInsertion(editor, "Agent block", "b1", ["a1"]),
          blockInsertion(editor, "Writer block", "b2", ["w1"]),
        ],
      ),
    );
    expect(marked(editor, "meridian-review-block.meridian-review-added")).toEqual(["Agent block."]);
    expect(marked(editor, "meridian-review-writer")).toEqual(["Writer block."]);
  });

  it("paints an unclassified block neutral, not as the AI's", () => {
    const { editor } = createReviewEditor(["Before.", "Loose block."]);
    const key = unattributedHunkKey("b-loose");
    setModel(
      editor,
      model([], [blockInsertion(editor, "Loose block", "b-loose", [key], { unclassified: true })]),
    );
    expect(marked(editor, "meridian-review-merged")).toEqual(["Loose block."]);
    expect(marked(editor, "meridian-review-added")).toEqual([]);
    expect(marked(editor, "meridian-review-block")).toEqual(["Loose block."]);
  });
});

describe("removals", () => {
  it("shows AI-removed live text struck inline, outside the document", () => {
    const { editor, doc } = createReviewEditor(["Elder Mo raised one withered hand."]);
    const withered = posOf(editor, "one withered");
    setModel(
      editor,
      model(
        [operation("a1", "agent")],
        [
          textHunk(
            editor,
            "h1",
            ["a1"],
            { from: withered, to: withered + 12 },
            {
              spans: [span(editor, "a1", withered, withered + 12)],
              deletedText: "his",
            },
          ),
        ],
      ),
    );
    const [removal] = removals(editor);
    expect(removal?.querySelector("del")?.textContent).toBe("his");
    expect(removal?.classList.contains("meridian-review-removal-writer")).toBe(false);
    expect(removal?.getAttribute("contenteditable")).toBe("false");
    // Never part of the document or the Y.Doc.
    expect(editor.getText()).toBe("Elder Mo raised one withered hand.");
    expect(editor.getHTML()).not.toContain("his");
    expect(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toString()).not.toContain("his");
  });

  it("strikes an unclassified removal in full, in no author's colour", () => {
    const { editor } = createReviewEditor(["Lin Feng counted the breath."]);
    const at = posOf(editor, "breath");
    const key = unattributedHunkKey("h-loose");
    setModel(
      editor,
      model(
        [],
        [
          textHunk(
            editor,
            "h-loose",
            [key],
            { from: at, to: at },
            { deletedText: "first slow ", deletedSpans: [], unclassified: true },
          ),
        ],
      ),
    );
    const [removal] = removals(editor);
    const del = removal?.querySelector("del");
    expect(del?.textContent).toBe("first slow ");
    expect(del?.classList.contains("meridian-review-removal-text-unattributed")).toBe(true);
    expect(del?.classList.contains("meridian-review-removal-text-writer")).toBe(false);
    expect(removal?.classList.contains("meridian-review-removal-writer")).toBe(false);
    expect(editor.getText()).not.toContain("first slow");

    // Focusing it by its key emphasises it, as a click on it does.
    editor.commands.setInlineReviewActiveOperation(key);
    expect(removals(editor)[0]?.classList.contains("meridian-review-emphasized")).toBe(true);
  });

  it("paints an unclassified insertion neutral, not as the AI's", () => {
    const { editor } = createReviewEditor(["Elder Mo raised one withered hand."]);
    const withered = posOf(editor, "one withered");
    setModel(
      editor,
      model(
        [],
        [
          textHunk(
            editor,
            "h-loose",
            [unattributedHunkKey("h-loose")],
            { from: withered, to: withered + 12 },
            { unclassified: true },
          ),
        ],
      ),
    );
    expect(marked(editor, "meridian-review-merged")).toEqual(["one withered"]);
    expect(marked(editor, "meridian-review-added")).toEqual([]);
  });

  it("strikes an unclassified block removal in no author's colour", () => {
    const { editor } = createReviewEditor(["Before.", "After."]);
    const after = posOf(editor, "After") - 1;
    const key = unattributedHunkKey("b-loose");
    setModel(
      editor,
      model(
        [],
        [
          {
            kind: "block",
            hunkId: "b-loose",
            operationIds: [key],
            unclassified: true,
            relStart: rel(editor, after),
            relEnd: rel(editor, after),
            deletedBlock: { type: "paragraph", display: "A gone paragraph." },
          },
        ],
      ),
    );
    const del = removals(editor)[0]?.querySelector("del");
    expect(del?.textContent).toBe("A gone paragraph.");
    expect(del?.classList.contains("meridian-review-removal-text-unattributed")).toBe(true);
  });

  it("folds an entirely unattributed removal under a neutral label, not the AI's", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    const between = posOf(editor, "Keep two") - 1;
    const key = unattributedHunkKey("h-loose");
    setModel(
      editor,
      model(
        [],
        [
          textHunk(
            editor,
            "h-loose",
            [key],
            { from: between, to: between },
            {
              deletedText: "q".repeat(REMOVAL_COLLAPSE_CHARS + 10),
              deletedSpans: [],
              unclassified: true,
            },
          ),
        ],
      ),
    );
    const [folded] = removals(editor);
    expect(folded?.querySelector("button")).not.toBeNull();
    expect(folded?.classList.contains("meridian-review-removal-unattributed")).toBe(true);
    // Opening it keeps the root neutral, matching the text it reveals.
    folded?.querySelector("button")?.click();
    expect(removals(editor)[0]?.classList.contains("meridian-review-removal-unattributed")).toBe(
      true,
    );
  });

  it("keeps the AI's colour on a fold that mixes unattributed text with the AI's", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    const between = posOf(editor, "Keep two") - 1;
    setModel(
      editor,
      model(
        [operation("a1", "agent")],
        [
          textHunk(
            editor,
            "h1",
            ["a1"],
            { from: between, to: between },
            { deletedText: "x".repeat(REMOVAL_COLLAPSE_CHARS + 10) },
          ),
        ],
      ),
    );
    const [folded] = removals(editor);
    expect(folded?.classList.contains("meridian-review-removal-unattributed")).toBe(false);
  });

  it("strikes the writer's removal of live text in gold", () => {
    const { editor } = createReviewEditor(["Lin Feng counted the breath."]);
    const at = posOf(editor, "breath");
    setModel(
      editor,
      model(
        [operation("w1", "writer")],
        [
          textHunk(
            editor,
            "h1",
            ["w1"],
            { from: at, to: at },
            { deletedText: "first ", deletedSpans: [{ from: 0, to: 6, deletedBy: "writer" }] },
          ),
        ],
      ),
    );
    const [removal] = removals(editor);
    expect(removal?.querySelector("del")?.textContent).toBe("first ");
    expect(removal?.classList.contains("meridian-review-removal-writer")).toBe(true);
    expect(editor.getText()).not.toContain("first");
  });

  it("strikes each stretch of one removal in its remover's colour", () => {
    const { editor } = createReviewEditor(["He raised his hand."]);
    const at = posOf(editor, "hand");
    const spans: ReviewDeletedSpan[] = [
      { from: 0, to: 6, deletedBy: "agent" },
      { from: 6, to: 11, deletedBy: "writer" },
    ];
    setModel(
      editor,
      model(
        [operation("a1", "agent", "closure:x"), operation("w1", "writer", "closure:x")],
        [
          textHunk(
            editor,
            "h1",
            ["a1", "w1"],
            { from: at, to: at + 4 },
            { deletedText: "sword blade", deletedSpans: spans },
          ),
        ],
      ),
    );
    const [removal] = removals(editor);
    const struck = [...(removal?.querySelectorAll("del") ?? [])];
    expect(struck.map((del) => del.textContent)).toEqual(["sword ", "blade"]);
    expect(
      struck.map((del) => del.classList.contains("meridian-review-removal-text-writer")),
    ).toEqual([false, true]);
    // Mixed authors: the fold, if any, reads as the AI's.
    expect(removal?.classList.contains("meridian-review-removal-writer")).toBe(false);
  });

  it("reads a block removal by its owning operations", () => {
    const { editor } = createReviewEditor(["Before.", "After."]);
    const after = posOf(editor, "After") - 1;
    setModel(
      editor,
      model(
        [operation("w1", "writer")],
        [
          {
            kind: "block",
            hunkId: "b1",
            operationIds: ["w1"],
            relStart: rel(editor, after),
            relEnd: rel(editor, after),
            deletedBlock: { type: "paragraph", display: "A gone paragraph." },
          },
        ],
      ),
    );
    const del = removals(editor)[0]?.querySelector("del");
    expect(del?.textContent).toBe("A gone paragraph.");
    expect(del?.classList.contains("meridian-review-removal-text-writer")).toBe(true);
  });

  it("folds adjacent deleted paragraphs into one count and expands on click", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    const between = posOf(editor, "Keep two") - 1;
    const long = "The courtyard held its breath while the elders conferred. ".repeat(2);
    const hunks = [0, 1, 2].map((i) =>
      textHunk(
        editor,
        `h${i}`,
        ["a1"],
        { from: between, to: between },
        {
          deletedText: `${i}: ${long}`,
        },
      ),
    );
    setModel(editor, model([operation("a1", "agent")], hunks));

    expect(removals(editor)).toHaveLength(1);
    const [group] = removals(editor);
    expect(group?.tagName).toBe("DIV");
    expect(group?.querySelector("button")?.textContent).toBe("3 paragraphs removed");

    group?.querySelector("button")?.click();
    const open = removals(editor)[0];
    expect(open?.querySelectorAll("del")).toHaveLength(3);
    expect(open?.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(editor.getText()).not.toContain("courtyard");

    open?.querySelector("button")?.click();
    expect(removals(editor)[0]?.querySelectorAll("del")).toHaveLength(0);
  });

  it("keeps an unfolded removal open across a model refresh", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    const between = posOf(editor, "Keep two") - 1;
    const next = () =>
      model(
        [operation("a1", "agent")],
        [
          textHunk(
            editor,
            "h1",
            ["a1"],
            { from: between, to: between },
            {
              deletedText: "y".repeat(REMOVAL_COLLAPSE_CHARS + 50),
            },
          ),
        ],
      );
    setModel(editor, next());
    removals(editor)[0]?.querySelector("button")?.click();
    setModel(editor, next());
    expect(removals(editor)[0]?.querySelector("del")).not.toBeNull();
  });

  it("is not selectable into and not clickable into the document", () => {
    const { editor } = createReviewEditor(["Alpha beta."]);
    const at = posOf(editor, "beta");
    setModel(
      editor,
      model(
        [operation("a1", "agent")],
        [textHunk(editor, "h1", ["a1"], { from: at, to: at }, { deletedText: "gone" })],
      ),
    );
    const before = editor.state.selection.from;
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    removals(editor)[0]?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(before);
  });
});

describe("clicking a removal", () => {
  function foldedModel(editor: Editor): InlineReviewModel {
    const between = posOf(editor, "Keep two") - 1;
    return model(
      [operation("a1", "agent")],
      [
        textHunk(
          editor,
          "h1",
          ["a1"],
          { from: between, to: between },
          {
            deletedText: "z".repeat(REMOVAL_COLLAPSE_CHARS + 20),
          },
        ),
      ],
    );
  }

  it("selects its change and opens the fold on one mouse click", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    setModel(editor, foldedModel(editor));
    const toggle = removals(editor)[0]?.querySelector("button");
    // A real click is press, then release: the press must not rebuild the
    // widget out from under the release.
    toggle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(removals(editor)[0]?.querySelector("button")).toBe(toggle);
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(removals(editor)[0]?.querySelector("del")).not.toBeNull();
    expect(removals(editor)[0]?.classList.contains("meridian-review-emphasized")).toBe(true);
  });

  it("keeps keyboard focus on the fold after Enter rebuilds it", async () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    document.body.append(editor.view.dom.parentElement as HTMLElement);
    setModel(editor, foldedModel(editor));
    // `click()` with no pointer is what Enter on a focused button sends.
    removals(editor)[0]?.querySelector("button")?.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(removals(editor)[0]?.querySelector("button"));
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("clicking a removal puts the caret where it stands", () => {
  const pressAndRelease = (removal: HTMLElement | undefined, clientX: number, clientY = 0) => {
    removal?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    removal?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX, clientY }));
  };
  /**
   * jsdom lays nothing out: give the widget a box so a click has a side. Like a
   * browser, a widget that has left the document has no box, so a side read
   * after the click rebuilt the widget comes out as zero.
   */
  const boxed = (removal: HTMLElement | undefined) =>
    vi
      .spyOn(removal as HTMLElement, "getBoundingClientRect")
      .mockImplementation(
        () =>
          (removal?.parentNode
            ? { left: 100, top: 10, width: 40, height: 20 }
            : { left: 0, top: 0, width: 0, height: 0 }) as DOMRect,
      );

  it("moves the caret to the removal's position, so typing lands there", () => {
    const { editor } = createReviewEditor(["Alpha beta gamma."]);
    const at = posOf(editor, "beta");
    editor.commands.setTextSelection(posOf(editor, "gamma"));
    setModel(
      editor,
      model(
        [operation("a1", "agent")],
        [textHunk(editor, "h1", ["a1"], { from: at, to: at }, { deletedText: "gone" })],
      ),
    );
    const [removal] = removals(editor);
    boxed(removal);
    pressAndRelease(removal, 110);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(at);

    editor.commands.insertContent("X");
    expect(editor.getText()).toBe("Alpha Xbeta gamma.");
    // The removal itself is still not part of the document.
    expect(editor.getText()).not.toContain("gone");
  });

  it("puts the caret at the end of the text before a removed paragraph for the upper half, at the start of the text after it for the lower", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    const between = posOf(editor, "Keep two") - 1;
    setModel(
      editor,
      model(
        [operation("a1", "agent")],
        [
          textHunk(
            editor,
            "h1",
            ["a1"],
            { from: between, to: between },
            { deletedText: "Removed paragraph." },
          ),
        ],
      ),
    );
    const [removal] = removals(editor);
    boxed(removal);
    // The first click focuses the change and rebuilds the widget under the pointer.
    pressAndRelease(removal, 110, 12);
    expect(editor.state.selection.from).toBe(posOf(editor, "one.") + 4);
    const [rebuilt] = removals(editor);
    boxed(rebuilt);
    pressAndRelease(rebuilt, 110, 25);
    expect(editor.state.selection.from).toBe(posOf(editor, "Keep two"));
  });

  it("does not move the caret when the click opens a fold", () => {
    const { editor } = createReviewEditor(["Keep one.", "Keep two."]);
    const between = posOf(editor, "Keep two") - 1;
    editor.commands.setTextSelection(2);
    setModel(
      editor,
      model(
        [operation("a1", "agent")],
        [
          textHunk(
            editor,
            "h1",
            ["a1"],
            { from: between, to: between },
            { deletedText: "z".repeat(REMOVAL_COLLAPSE_CHARS + 20) },
          ),
        ],
      ),
    );
    const toggle = removals(editor)[0]?.querySelector("button");
    toggle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(editor.state.selection.from).toBe(2);
  });
});

describe("focus and visibility", () => {
  function focusModel(editor: Editor): InlineReviewModel {
    const first = posOf(editor, "alpha");
    const second = posOf(editor, "beta");
    const third = posOf(editor, "gamma");
    return model(
      [
        operation("a1", "agent", "closure:one"),
        operation("w1", "writer", "closure:one"),
        operation("a2", "agent", "closure:two"),
      ],
      [
        textHunk(
          editor,
          "h1",
          ["a1"],
          { from: first, to: first + 5 },
          {
            spans: [span(editor, "a1", first, first + 5)],
          },
        ),
        textHunk(
          editor,
          "h2",
          ["w1"],
          { from: second, to: second + 4 },
          {
            spans: [span(editor, "w1", second, second + 4)],
          },
        ),
        textHunk(
          editor,
          "h3",
          ["a2"],
          { from: third, to: third + 5 },
          {
            spans: [span(editor, "a2", third, third + 5)],
            deletedText: "old",
          },
        ),
      ],
    );
  }

  it("emphasizes every operation of the focused change and nothing else", () => {
    const { editor } = createReviewEditor(["alpha beta gamma."]);
    setModel(editor, focusModel(editor));
    expect(marked(editor, "meridian-review-emphasized")).toEqual([]);

    editor.commands.setInlineReviewActiveOperation("w1");
    expect(marked(editor, "meridian-review-emphasized")).toEqual(["alpha", "beta"]);

    editor.commands.setInlineReviewActiveOperation("a2");
    expect(marked(editor, "meridian-review-emphasized").sort()).toEqual(["gamma", "old"]);

    editor.commands.setInlineReviewActiveOperation(null);
    expect(marked(editor, "meridian-review-emphasized")).toEqual([]);
  });

  it("pulses the marks of a change that just arrived, marks and removal alike, and stops when told", () => {
    const { editor } = createReviewEditor(["alpha beta gamma."]);
    setModel(editor, focusModel(editor));
    expect(marked(editor, "meridian-review-arrived")).toEqual([]);

    editor.commands.setInlineReviewPulse(["a2"]);
    expect(marked(editor, "meridian-review-arrived").sort()).toEqual(["gamma", "old"]);

    editor.commands.setInlineReviewPulse([]);
    expect(marked(editor, "meridian-review-arrived")).toEqual([]);
  });

  it("hides every mark and removal without losing the model, then restores them", () => {
    const { editor } = createReviewEditor(["alpha beta gamma."]);
    setModel(editor, focusModel(editor));
    editor.commands.setInlineReviewActiveOperation("a2");

    editor.commands.setInlineReviewMarksVisible(false);
    expect(marked(editor, "meridian-review-added")).toEqual([]);
    expect(marked(editor, "meridian-review-writer")).toEqual([]);
    expect(removals(editor)).toHaveLength(0);
    expect(editor.getText()).toBe("alpha beta gamma.");

    editor.commands.setInlineReviewMarksVisible(true);
    expect(marked(editor, "meridian-review-added")).toEqual(["alpha", "gamma"]);
    expect(removals(editor)).toHaveLength(1);
    expect(marked(editor, "meridian-review-emphasized").sort()).toEqual(["gamma", "old"]);
  });

  it("does not paint typed text while marks are hidden", () => {
    const { editor } = createReviewEditor(["alpha beta gamma."]);
    setModel(editor, focusModel(editor));
    editor.commands.setInlineReviewMarksVisible(false);
    editor.chain().setTextSelection(posOf(editor, "gamma")).insertContent("zz").run();
    expect(marked(editor, "meridian-review-writer")).toEqual([]);
  });
});

describe("repainting without re-resolving", () => {
  function threeHunks(editor: Editor): InlineReviewModel {
    const first = posOf(editor, "alpha");
    const second = posOf(editor, "beta");
    const third = posOf(editor, "gamma");
    const hunk = (id: string, op: string, from: number, to: number, extra = {}) =>
      textHunk(editor, id, [op], { from, to }, { spans: [span(editor, op, from, to)], ...extra });
    return model(
      [
        operation("a1", "agent", "c1"),
        operation("a2", "agent", "c2"),
        operation("a3", "agent", "c3"),
      ],
      [
        hunk("h1", "a1", first, first + 5),
        hunk("h2", "a2", second, second + 4),
        hunk("h3", "a3", third, third + 5, { deletedText: "old" }),
      ],
    );
  }

  it("re-anchors after the writer types, so a focus step marks the right words", () => {
    const { editor } = createReviewEditor(["alpha beta gamma."]);
    setModel(editor, threeHunks(editor));
    const settled = resolutions.count;
    editor.chain().setTextSelection(1).insertContent("Well, ").run();
    editor.commands.setInlineReviewActiveOperation("a2");
    expect(resolutions.count).toBeGreaterThan(settled);
    expect(marked(editor, "meridian-review-emphasized")).toEqual(["beta"]);
    expect(editor.getText()).toBe("Well, alpha beta gamma.");
  });

  it("re-anchors after a remote edit moves the words", () => {
    const { editor, doc } = createReviewEditor(["alpha beta gamma."]);
    setModel(editor, threeHunks(editor));
    const settled = resolutions.count;
    const text = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement;
    doc.transact(() => (text.get(0) as Y.XmlText).insert(0, "Remote "), "remote");
    expect(resolutions.count).toBeGreaterThan(settled);
    editor.commands.setInlineReviewActiveOperation("a2");
    expect(marked(editor, "meridian-review-emphasized")).toEqual(["beta"]);
  });
});
