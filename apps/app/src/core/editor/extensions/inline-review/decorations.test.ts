// @vitest-environment jsdom
/**
 * Decoration model for in-manuscript draft review: each kind of change, the
 * removal widget and its fold, focus, and hidden marks, driven through a real
 * collaborative TipTap editor so anchors resolve exactly as they do in review.
 */

import type { ReviewOperation } from "@meridian/contracts/drafts";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { relativePositionForEditorIndex } from "../../../../test-support/editor-relative-position";
import { createEditorConfig } from "../../config";
import { createLocalPresence } from "../../local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "../../schema";
import type { InlineReviewModel, ResolvedReviewHunk, ResolvedReviewSpan } from "./model";
import { REMOVAL_COLLAPSE_CHARS } from "./removal-widget";

const editors: Editor[] = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  for (const editor of editors.splice(0)) if (!editor.isDestroyed) editor.destroy();
  vi.unstubAllGlobals();
});

function createReviewEditor(paragraphs: string[]): { editor: Editor; doc: Y.Doc } {
  const doc = new Y.Doc({ gc: false });
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  doc.transact(() => {
    for (const text of paragraphs) {
      const paragraph = new Y.XmlElement("paragraph");
      const run = new Y.XmlText();
      paragraph.insert(0, [run]);
      run.insert(0, text);
      fragment.insert(fragment.length, [paragraph]);
    }
  }, "seed");
  const editor = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({
      document: doc,
      presence: createLocalPresence(new Awareness(doc)),
      showCollaborationDecorations: false,
      enableDraftInlineReview: true,
    }),
  });
  editors.push(editor);
  return { editor, doc };
}

/** Absolute editor position of the first character of `needle`. */
function posOf(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return;
    const at = node.text?.indexOf(needle) ?? -1;
    if (at >= 0) found = pos + at;
  });
  if (found < 0) throw new Error(`"${needle}" not in document`);
  return found;
}

function rel(editor: Editor, position: number): Y.RelativePosition {
  const anchor = relativePositionForEditorIndex(editor, position);
  if (!anchor) throw new Error("editor has no Yjs binding");
  return anchor;
}

function operation(
  operationId: string,
  kind: "agent" | "writer",
  closureClassId = `closure:${operationId}`,
): ReviewOperation {
  return {
    operationId,
    closureClassId,
    kind,
    contribution: "added",
    classification: "rewrite",
    hunkCount: 1,
  };
}

function span(editor: Editor, operationId: string, from: number, to: number): ResolvedReviewSpan {
  return { operationId, from: rel(editor, from), to: rel(editor, to) };
}

function textHunk(
  editor: Editor,
  hunkId: string,
  operationIds: string[],
  range: { from: number; to: number },
  extra: {
    spans?: ResolvedReviewSpan[];
    deletedText?: string;
    mergeArtifact?: boolean;
  } = {},
): ResolvedReviewHunk {
  return {
    kind: "text",
    hunkId,
    operationIds,
    relStart: rel(editor, range.from),
    relEnd: rel(editor, range.to),
    spans: extra.spans ?? [],
    ...(extra.deletedText ? { deletedText: extra.deletedText } : {}),
    ...(extra.mergeArtifact ? { mergeArtifact: true } : {}),
  };
}

function model(operations: ReviewOperation[], hunks: ResolvedReviewHunk[]): InlineReviewModel {
  return { draftRevisionToken: "1", operations, hunks };
}

function setModel(editor: Editor, next: InlineReviewModel): void {
  editor.commands.setInlineReviewModel(next);
}

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
          // The server flags any hunk holding both authors as a merge artifact;
          // one writer run inside AI text is still readable by author.
          textHunk(
            editor,
            "h1",
            ["a1", "w1"],
            { from: start, to: end },
            {
              mergeArtifact: true,
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

  it("paints a merge the author runs cannot explain as one dashed grey region", () => {
    const { editor } = createReviewEditor(["The outer disciples fell back to their knees."]);
    const start = posOf(editor, "fell");
    const end = posOf(editor, ".");
    const cuts = [start, start + 4, start + 9, start + 14, start + 20, end];
    const kinds = ["a1", "w1", "a1", "w1", "a1"];
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
              spans: kinds.map((id, i) =>
                span(editor, id, cuts[i] as number, cuts[i + 1] as number),
              ),
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

  it("strikes the writer's removal of live text in gold", () => {
    const { editor } = createReviewEditor(["Lin Feng counted the breath."]);
    const at = posOf(editor, "breath");
    setModel(
      editor,
      model(
        [operation("w1", "writer")],
        [textHunk(editor, "h1", ["w1"], { from: at, to: at }, { deletedText: "first " })],
      ),
    );
    const [removal] = removals(editor);
    expect(removal?.querySelector("del")?.textContent).toBe("first ");
    expect(removal?.classList.contains("meridian-review-removal-writer")).toBe(true);
    expect(editor.getText()).not.toContain("first");
  });

  it("calls a replacement the AI's when the writer edited inside it", () => {
    const { editor } = createReviewEditor(["He raised one withered hand."]);
    const at = posOf(editor, "one withered");
    setModel(
      editor,
      model(
        [operation("a1", "agent", "closure:x"), operation("w1", "writer", "closure:x")],
        [textHunk(editor, "h1", ["a1", "w1"], { from: at, to: at + 12 }, { deletedText: "his" })],
      ),
    );
    expect(removals(editor)[0]?.classList.contains("meridian-review-removal-writer")).toBe(false);
  });

  it("keeps short removals open and folds past the character threshold", () => {
    const { editor } = createReviewEditor(["Before.", "After."]);
    const after = posOf(editor, "After") - 1;
    const build = (chars: number) =>
      setModel(
        editor,
        model(
          [operation("a1", "agent")],
          [
            textHunk(
              editor,
              "h1",
              ["a1"],
              { from: after, to: after },
              {
                deletedText: "x".repeat(chars),
              },
            ),
          ],
        ),
      );

    build(REMOVAL_COLLAPSE_CHARS);
    expect(removals(editor)[0]?.querySelector("button")).toBeNull();
    expect(removals(editor)[0]?.querySelector("del")?.textContent).toHaveLength(
      REMOVAL_COLLAPSE_CHARS,
    );

    build(REMOVAL_COLLAPSE_CHARS + 1);
    const folded = removals(editor)[0];
    expect(folded?.querySelector("del")).toBeNull();
    expect(folded?.querySelector("button")?.textContent).toBe("1 paragraph removed");
    expect(folded?.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
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
