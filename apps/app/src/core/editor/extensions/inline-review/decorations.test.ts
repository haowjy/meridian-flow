// @vitest-environment jsdom
/**
 * The review's paint: where a hunk's green and red land in the editor, and the two risks that make the
 * review lie: a removal drawn at the wrong block boundary, and a review repainted from a stale base.
 */

import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import type { DocumentSessionSnapshot } from "@/core/editor/document-session";
import { readBase } from "@/features/draft-review/review-frame";
import {
  createReviewRuntime,
  REVIEW_DEBOUNCE_MS,
  type ReviewRuntime,
} from "@/features/draft-review/review-runtime";
import {
  attachReviewRuntime,
  createReviewEditor,
  destroyReviewEditors,
  seedReviewBase,
} from "@/test-support/inline-review-editor";
import { getInlineReviewPluginState } from "./DraftInlineReviewExtension";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hunk placement", () => {
  it("paints inserted words green and the words they replaced red, ahead of the green", () => {
    const { editor } = reviewing(["Alpha beta gamma delta"], ["Alpha BETA gamma delta"]);
    expect(added(editor)).toEqual(["BETA"]);
    const [removal] = removals(editor);
    // A removed word brings the space before it, unstruck, so it never fuses: "Alpha ~~beta~~ BETA".
    expect(removal?.textContent).toBe(" beta");
    expect(removal?.querySelector("del")?.textContent).toBe("beta");
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
    vi.advanceTimersByTime(REVIEW_DEBOUNCE_MS - 1);
    expect(added(editor)).toEqual(["BETA"]);
    vi.advanceTimersByTime(2);
    expect(added(editor).join("")).toContain("Oh");
  });
});

it("retains mark and removal DOM while typing inside a change and changing emphasis", () => {
  const { editor, projector } = reviewing(["The door is red."], ["The door is green."]);
  const mark = editor.view.dom.querySelector(`.${inlineReviewClassNames.added}`);
  const removal = removals(editor)[0];
  editor.commands.setTextSelection(15);
  const input = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: "x",
    bubbles: true,
    cancelable: true,
  });
  // jsdom has no native target-range implementation.
  Object.defineProperty(input, "getTargetRanges", { value: () => [] });
  editor.view.dom.dispatchEvent(input);
  expect(input.defaultPrevented).toBe(true);
  expect(editor.state.doc.textContent).toBe("The door is grxeen.");
  projector.projectNow();
  expect(editor.view.dom.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(removals(editor)[0]).toBe(removal);
  const id = mark?.getAttribute("data-review-change") ?? null;
  editor.commands.setReviewActiveChange(id);
  expect(editor.view.dom.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(removals(editor)[0]).toBe(removal);
  expect(mark?.classList.contains(inlineReviewClassNames.emphasized)).toBe(true);
});

it("defers projected paint during composition and consumes a pulse at the DOM only once", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { editor, projector } = reviewing(["The door is red."], ["The door is green."]);
  const root = editor.view.dom;
  const mark = root.querySelector(`.${inlineReviewClassNames.added}`);
  const removal = removals(editor)[0];
  root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  editor.commands.insertContentAt(15, "x");
  const mapped = getInlineReviewPluginState(editor.state)?.decorations;
  projector.projectNow();
  expect(getInlineReviewPluginState(editor.state)?.decorations).toBe(mapped);
  expect(root.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(removals(editor)[0]).toBe(removal);
  const arrivingId = getInlineReviewPluginState(editor.state)?.review?.groups[0].id;
  if (!arrivingId) throw new Error("Missing arrival");
  editor.commands.setReviewPulse([arrivingId]);
  expect(mark?.classList.contains(inlineReviewClassNames.arrived)).toBe(false);
  editor.commands.insertContentAt(15, "y");
  projector.projectNow();
  root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  vi.advanceTimersByTime(25);
  const id = mark?.getAttribute("data-review-change");
  if (!id || !mark) throw new Error("Missing painted change");
  expect(mark.classList.contains(inlineReviewClassNames.arrived)).toBe(true);
  mark.dispatchEvent(new Event("animationend", { bubbles: true }));
  expect(mark.classList.contains(inlineReviewClassNames.arrived)).toBe(false);
  projector.projectNow();
  editor.commands.setReviewActiveChange(id);
  editor.commands.setReviewPulse([arrivingId]);
  expect(root.querySelector(`.${inlineReviewClassNames.added}`)).toBe(mark);
  expect(mark.classList.contains(inlineReviewClassNames.arrived)).toBe(false);
  editor.commands.setReviewMarksVisible(false);
  editor.commands.setReviewMarksVisible(true);
  expect(root.querySelector(`.${inlineReviewClassNames.arrived}`)).toBeNull();
});

it("caches the supplied base across typing but invalidates it on a provider change", () => {
  const { editor, doc } = createReviewEditor(["Alpha BETA gamma delta"]);
  seedReviewBase(doc, ["Alpha beta gamma delta"]);
  const provider = vi.fn((_room, schema) => readBase(doc, schema));
  const runtime = createReviewRuntime(
    {
      document: doc,
      subscribe: () => () => {},
      getSnapshot: () => ({ status: "synced" }) as never,
    },
    provider,
  );
  projectors.push(runtime);
  runtime.attachEditor(editor);
  editor.commands.insertContentAt(1, "Oh ");
  runtime.projectNow();
  expect(provider).toHaveBeenCalledTimes(1);
  runtime.invalidateBase();
  runtime.projectNow();
  expect(provider).toHaveBeenCalledTimes(2);
  runtime.setBaseProvider(() => [...editor.state.doc.content.content]);
  runtime.projectNow();
  expect(runtime.state().changes).toHaveLength(0);
});

it("keeps a cached projection unready until sync and retains untouched nodes after editor detach", () => {
  const { editor, doc } = createReviewEditor([
    "First paragraph",
    "The door is green.",
    "Last paragraph",
  ]);
  seedReviewBase(doc, ["First paragraph", "The door is red.", "Last paragraph"]);
  let notify = (_snapshot: DocumentSessionSnapshot) => {};
  const runtime = createReviewRuntime({
    document: doc,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
    getSnapshot: () => ({ status: "offline" }) as never,
  });
  projectors.push(runtime);
  const detach = runtime.attachEditor(editor);
  expect(runtime.state().changes).toHaveLength(1);
  expect(runtime.state().ready).toBe(false);
  notify({ status: "synced" } as DocumentSessionSnapshot);
  runtime.projectNow();
  expect(runtime.state().ready).toBe(true);
  const first = runtime.state().frame?.doc.child(0);
  const last = runtime.state().frame?.doc.child(2);
  detach();
  const paragraph = doc.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
  (paragraph.get(0) as Y.XmlText).insert(0, "Now ");
  runtime.projectNow();
  expect(runtime.state().frame?.doc.child(0)).toBe(first);
  expect(runtime.state().frame?.doc.child(2)).toBe(last);
});
