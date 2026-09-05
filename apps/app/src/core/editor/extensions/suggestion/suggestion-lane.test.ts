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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSuggestionDriver,
  type SuggestionChoiceAction,
  type SuggestionDriverFrame,
  type SuggestionHost,
} from "@/core/completion";
import { getEditorChrome } from "../../chrome";
import { createStandaloneEditorExtensions } from "../../config";
import { editorSuggestionHost } from "../../suggestion-host";
import { createSuggestionLane, defaultSuggestionLaneDriver } from "./suggestion-lane";

type WordCatalog = { title: string; words: readonly string[] };
type WordItem = { word: string };
type WordEntry = WordItem & { tooLong: boolean };

const CATALOG: WordCatalog = { title: "Offer a word", words: ["ember", "emberling", "quill"] };
const backtrackWordLane = vi.fn(() => true);
const chooseWordLane = vi.fn<(action: SuggestionChoiceAction) => void>();

/**
 * A lane with every optional field exercised: a projection that reads the
 * document, a refusal, and meta the rows do not carry.
 */
const wordLane = createSuggestionLane<WordCatalog, WordItem, WordEntry, { title: string }>({
  name: "testWordLane",
  char: "%",
  driver: defaultSuggestionLaneDriver,
  keymapId: "test-word-lane",
  label: (catalog) => catalog.title,
  allows: () => true,
  rowId: (entry) => entry.word,
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
  choose: ({ editor, range, entry, action }) => {
    chooseWordLane(action);
    editor.commands.insertContentAt(range, entry.word);
  },
  backtrack: () => backtrackWordLane(),
  keyBindings: (menu) => ({
    ArrowDown: () => menu.move(1),
    ArrowUp: () => menu.move(-1),
    Home: () => menu.moveTo("first"),
    End: () => menu.moveTo("last"),
    Enter: () => menu.chooseActive("enter"),
    Tab: () => menu.chooseActive("tab"),
  }),
});

const forwarded = {
  starts: [] as SuggestionDriverFrame<WordItem>[],
  updates: [] as SuggestionDriverFrame<WordItem>[],
  exits: 0,
};
const forwardingLane = createSuggestionLane<WordCatalog, WordItem>({
  name: "forwardingLane",
  char: "^",
  keymapId: "forwarding-lane",
  allows: () => true,
  label: (catalog) => catalog.title,
  rowId: (row) => row.word,
  items: (catalog, query) =>
    catalog.words.filter((word) => word.startsWith(query)).map((word) => ({ word })),
  choose: () => {},
  driver: ({ defaultProject }) => {
    const owned = createDefaultSuggestionDriver({ project: defaultProject });
    return {
      menu: owned.menu,
      start: (frame) => {
        forwarded.starts.push(frame);
        owned.start(frame);
      },
      update: (frame) => {
        forwarded.updates.push(frame);
        owned.update(frame);
      },
      exit: () => {
        forwarded.exits += 1;
        owned.exit();
      },
    };
  },
});

let editor: Editor | null = null;
const releaseHost = vi.fn();
const registerHost = vi.fn<SuggestionHost["register"]>(() => ({ release: releaseHost }));

afterEach(() => {
  vi.clearAllMocks();
  editor?.destroy();
  editor = null;
});

function mount({ withLane = true } = {}) {
  const instance = new Editor({
    extensions: [
      ...createStandaloneEditorExtensions(),
      ...(withLane
        ? [
            wordLane.extension.configure({
              catalog: () => CATALOG,
              suggestionHost: () => ({ register: registerHost }),
            }),
          ]
        : []),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editor = instance;
  return instance;
}

function mountWithRealHost() {
  const instance = new Editor({
    extensions: [
      ...createStandaloneEditorExtensions(),
      wordLane.extension.configure({
        catalog: () => CATALOG,
        suggestionHost: (editor) => editorSuggestionHost(editor, "prose"),
      }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editor = instance;
  return instance;
}

function press(instance: Editor, key: string) {
  instance.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, keyCode: key === "Escape" ? 27 : 0, bubbles: true }),
  );
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
  it("forwards TipTap frames and exit to the mounted driver's exact menu", async () => {
    forwarded.starts.length = 0;
    forwarded.updates.length = 0;
    forwarded.exits = 0;
    const instance = new Editor({
      extensions: [
        ...createStandaloneEditorExtensions(),
        forwardingLane.extension.configure({
          catalog: () => CATALOG,
          suggestionHost: () => ({ register: registerHost }),
        }),
      ],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editor = instance;
    await type(instance, "^emb");
    expect(forwarded.starts).toHaveLength(1);
    expect(forwarded.starts[0]).toMatchObject({
      query: "emb",
      text: "^emb",
      triggerRange: { from: 1, to: 5 },
      loading: true,
    });
    expect(forwarded.starts[0]?.candidates).toEqual([]);
    expect(forwarded.updates.at(-1)?.candidates.map(({ word }) => word)).toEqual([
      "ember",
      "emberling",
    ]);
    expect(forwardingLane.getMenu(instance)?.snapshot().query).toBe("emb");
    instance.commands.insertContent("e");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.updates.at(-1)).toMatchObject({ query: "embe", text: "^embe" });
    forwardingLane.getMenu(instance)?.dismiss();
    expect(forwarded.exits).toBe(1);
  });
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
    await type(instance, "%emb");

    expect(registerHost).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-word-lane",
        bindings: expect.objectContaining({
          ArrowDown: expect.any(Function),
          ArrowUp: expect.any(Function),
          Enter: expect.any(Function),
        }),
      }),
    );
    const registration = registerHost.mock.calls.at(-1)?.[0];
    expect(registration?.bindings.ArrowDown?.()).toBe(true);
    expect(wordLane.getMenu(instance)?.snapshot().activeIndex).toBe(0);
  });

  it("registers the full hierarchical key contract through the shared menu", async () => {
    const instance = mount();
    await type(instance, "%emb");
    const registration = registerHost.mock.calls.at(-1)?.[0];
    const bindings = registration?.bindings;

    expect(Object.keys(bindings ?? {})).toEqual([
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      "Enter",
      "Tab",
    ]);
    expect(bindings?.End?.()).toBe(true);
    expect(wordLane.getMenu(instance)?.snapshot().activeId).toBe("ember");
    expect(bindings?.Home?.()).toBe(true);
    expect(registration?.retreat.backtrack()).toBe(true);
    expect(backtrackWordLane).toHaveBeenCalledOnce();
  });

  it("lets a Composer-style host place semantic retreat in its own precedence", async () => {
    const instance = mount();
    await type(instance, "%emb");
    const retreat = registerHost.mock.calls.at(-1)?.[0].retreat;
    expect(retreat?.backtrack()).toBe(true);

    backtrackWordLane.mockReturnValueOnce(false);
    releaseHost.mockClear();
    retreat?.dismiss();
    expect(wordLane.getMenu(instance)?.snapshot().open).toBe(false);
    expect(releaseHost).toHaveBeenCalledOnce();
  });

  it("keeps Enter and Tab as distinct choice intents", async () => {
    const enterEditor = mount();
    await type(enterEditor, "%quill");
    registerHost.mock.calls.at(-1)?.[0].bindings.Enter?.();
    expect(chooseWordLane).toHaveBeenLastCalledWith("enter");

    enterEditor.destroy();
    const tabEditor = mount();
    await type(tabEditor, "%quill");
    registerHost.mock.calls.at(-1)?.[0].bindings.Tab?.();
    expect(chooseWordLane).toHaveBeenLastCalledWith("tab");
  });

  it("runs the semantic lease through the mounted Chrome kernel", async () => {
    backtrackWordLane.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const instance = mountWithRealHost();
    const chrome = getEditorChrome(instance);
    expect(chrome).not.toBeNull();

    await type(instance, "%emb");
    expect(wordLane.getMenu(instance)?.snapshot().open).toBe(true);
    const suggestionKeys = () =>
      chrome?.keymapContributions().filter((entry) => entry.id === "test-word-lane") ?? [];
    expect(suggestionKeys()).toHaveLength(1);
    expect(Object.keys(suggestionKeys()[0]?.bindings ?? {})).toEqual([
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      "Enter",
      "Tab",
    ]);

    const menu = wordLane.getMenu(instance);
    const registeredRevision = chrome?.keymapRevision ?? 0;
    const visualLayer = chrome?.openLayer({
      id: "test-word-lane#mounted",
      ownerId: "test-word-lane",
      dismissal: "self",
      close: () => {
        visualLayer?.release();
        menu?.dismiss();
      },
    });
    expect(chrome?.layers).toHaveLength(1);

    const cancelGesture = vi.fn();
    chrome?.beginDrag(cancelGesture);
    press(instance, "Escape");
    expect(cancelGesture).toHaveBeenCalledOnce();
    expect(backtrackWordLane).not.toHaveBeenCalled();

    const rival = chrome?.openLayer({
      id: "rival-overlay",
      parentId: visualLayer?.id,
      close: () => rival?.release(),
    });
    press(instance, "Escape");
    expect(rival?.layer).not.toBe(chrome?.layers.at(-1));
    expect(chrome?.layers).toHaveLength(1);
    expect(backtrackWordLane).not.toHaveBeenCalled();

    press(instance, "End");
    expect(menu?.snapshot().activeId).toBe("ember");
    press(instance, "Home");
    expect(menu?.snapshot().activeId).toBe("ember");

    press(instance, "Escape");
    expect(backtrackWordLane).toHaveBeenCalledTimes(1);
    expect(chrome?.layers).toHaveLength(1);
    expect(menu?.snapshot().open).toBe(true);

    press(instance, "Escape");
    expect(backtrackWordLane).toHaveBeenCalledTimes(2);
    expect(chrome?.layers).toHaveLength(0);
    expect(menu?.snapshot().open).toBe(false);
    expect(suggestionKeys()).toHaveLength(0);

    // The stale presentation cleanup and editor teardown cannot release the
    // already-ended host registration a second time.
    visualLayer?.release();
    expect(chrome?.keymapRevision).toBe(registeredRevision + 1);
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
