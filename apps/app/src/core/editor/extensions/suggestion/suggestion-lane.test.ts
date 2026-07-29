// @vitest-environment jsdom
/**
 * The lane mechanism itself, driven by a spec that is not `/` or `[[`.
 *
 * `slash` and `wikilink` each test their own product rules against this
 * machinery. What is left over — and what a third trigger inherits sight
 * unseen — is that a spec alone buys the whole lifecycle: the char opens the
 * menu, the catalog's label and meta reach the surface, a projected row carries
 * document-dependent state, a refused row cannot be chosen, and the arrow keys
 * are bound from the plugin's own lifetime rather than a React effect.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { getEditorChrome } from "../../chrome";
import { createStandaloneEditorExtensions } from "../../config";
import { createSuggestionLane } from "./suggestion-lane";

type WordCatalog = { title: string; words: readonly string[] };
type WordItem = { word: string };
type WordEntry = WordItem & { tooLong: boolean };

const CATALOG: WordCatalog = { title: "Offer a word", words: ["ember", "emberling", "quill"] };

/**
 * A lane with every optional field exercised: a projection that reads the
 * document, a refusal, and meta the rows do not carry.
 */
const wordLane = createSuggestionLane<WordCatalog, WordItem, WordEntry, { title: string }>({
  name: "testWordLane",
  char: "%",
  keymapId: "test-word-lane",
  label: (catalog) => catalog.title,
  allows: () => true,
  items: (catalog, query) =>
    catalog.words.filter((word) => word.startsWith(query)).map((word) => ({ word })),
  // Reads the document a pick would act on, which is the whole reason this
  // stage exists separately from `items`.
  entries: ({ editor, range, items }) =>
    items.map((item) => ({
      ...item,
      tooLong: range.from + item.word.length > editor.state.doc.content.size,
    })),
  choosable: (entry) => !entry.tooLong,
  meta: (catalog) => ({ title: catalog.title }),
  choose: ({ editor, range, entry }) => {
    editor.commands.insertContentAt(range, entry.word);
  },
});

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount({ withLane = true } = {}) {
  const instance = new Editor({
    extensions: [
      ...createStandaloneEditorExtensions(),
      ...(withLane ? [wordLane.extension.configure({ catalog: () => CATALOG })] : []),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editor = instance;
  return instance;
}

/**
 * Types, then lets the microtask queue drain: `@tiptap/suggestion` resolves
 * `items()` through its async request manager even when the answer is a plain
 * array, so the menu's first painted state arrives one tick after the trigger.
 */
async function type(instance: Editor, text: string) {
  instance.commands.insertContent(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a lane declared as a spec", () => {
  it("opens on its own char and publishes the catalog through the store", async () => {
    const instance = mount();
    await type(instance, "%emb");

    const snapshot = wordLane.getMenu(instance)?.snapshot();
    expect(snapshot?.open).toBe(true);
    expect(snapshot?.items.map(({ word }) => word)).toEqual(["ember", "emberling"]);
    expect(snapshot?.query).toBe("emb");
    expect(snapshot?.label).toBe("Offer a word");
    expect(snapshot?.meta).toEqual({ title: "Offer a word" });
  });

  it("binds the arrow keys from the plugin's lifetime, before any surface renders", async () => {
    const instance = mount();
    await type(instance, "%");

    const bound = (getEditorChrome(instance)?.keymapContributions() ?? []).some(
      (contribution) => contribution.id === "test-word-lane",
    );
    expect(bound).toBe(true);
  });

  it("writes what the lane's choice writes, over the trigger's own range", async () => {
    const instance = mount();
    await type(instance, "%quill");
    wordLane.getMenu(instance)?.chooseActive();

    expect(instance.state.doc.textContent).toBe("quill");
  });

  it("refuses a row the lane refuses, and opens the highlight past it", async () => {
    const instance = mount();
    await type(instance, "%ember");

    const menu = wordLane.getMenu(instance);
    // The document is short, so the longer word cannot land: the lane says so
    // per row and the store honors it rather than the menu drawing a dead key.
    expect(menu?.snapshot().items.map(({ tooLong }) => tooLong)).toEqual([false, true]);
    expect(menu?.choose(1)).toBe(false);
    expect(menu?.snapshot().activeIndex).toBe(0);
    expect(instance.state.doc.textContent).toBe("%ember");
  });

  it("answers null for an editor that never mounted the lane", () => {
    expect(wordLane.getMenu(mount({ withLane: false }))).toBeNull();
    expect(wordLane.getMenu(null)).toBeNull();
  });
});
