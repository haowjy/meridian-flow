// @vitest-environment jsdom
/**
 * The `[[` trigger against a real editor.
 *
 * Three of these are about the two-character, space-carrying trigger being a
 * genuinely different animal from `/`: a document title has spaces in it, a
 * writer who closes their own brackets is done with the menu, and Escape has
 * to leave the literal `[[` text in the sentence rather than eat it.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import type { ReferenceCatalog } from "@/core/references";

import { createStandaloneEditorExtensions } from "../../config";
import { getWikilinkMenu } from "./WikilinkSuggestionExtension";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const CATALOG: ReferenceCatalog = {
  label: "Link a document",
  candidates: [
    doc("The Third Gate", "Chapters"),
    doc("Third Gate Aspirants", "Worldbuilding"),
    { ...doc("Warden Ilsever", "Characters"), aliases: ["The Warden"] },
    // Assets ride in the same catalog `@` will read; `[[` must never show one.
    {
      kind: "asset",
      name: "third-gate.png",
      location: "Assets",
      assetDocumentId: "asset-third-gate",
      path: "/assets/third-gate.png",
      fileType: "image",
      uri: "manuscript://assets/third-gate.png",
    },
  ],
};

function doc(title: string, location: string) {
  return {
    kind: "document",
    title,
    location,
    documentId: `document-${title}`,
    uri: `manuscript://${title}.md`,
  } as const;
}

function mount(content = "<p></p>") {
  let catalog: ReferenceCatalog | null = CATALOG;
  const instance = new Editor({
    extensions: createStandaloneEditorExtensions({ wikilinks: { catalog: () => catalog } }),
    content,
  });
  editor = instance;
  return {
    editor: instance,
    withdraw() {
      catalog = null;
      instance.setEditable(false);
    },
  };
}

/**
 * Types, then lets the microtask queue drain: `@tiptap/suggestion` resolves
 * `items()` through its async request manager even when the answer is a plain
 * array, so the menu's first painted state arrives one tick after the input.
 */
async function type(instance: Editor, text: string) {
  instance.commands.insertContent(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The same text through the keystroke path a browser drives, so auto-pairing
 * writes its closers exactly as it does for a writer. `insertContent` above
 * bypasses `handleTextInput` and therefore pairs nothing.
 */
async function keystrokes(instance: Editor, text: string) {
  for (const character of text) {
    const { from, to } = instance.state.selection;
    const insert = () => instance.state.tr.insertText(character, from, to);
    const handled = instance.view.someProp("handleTextInput", (handleTextInput) =>
      handleTextInput(instance.view, from, to, character, insert),
    );
    if (!handled) instance.view.dispatch(insert());
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const rows = (instance: Editor) =>
  getWikilinkMenu(instance)
    ?.snapshot()
    .items.map((item) => (item.kind === "create" ? `create:${item.name}` : item.name));

describe("the `[[` trigger against a live editor", () => {
  it("opens on the second bracket and offers every document", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[");

    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(true);
    expect(rows(instance)).toEqual(["The Third Gate", "Third Gate Aspirants", "Warden Ilsever"]);
  });

  it("keeps filtering through the spaces a document title has", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[the third");

    expect(rows(instance)).toEqual(["The Third Gate", "create:the third"]);
  });

  it("finds a document by an alias the writer remembered instead", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[the warden");

    expect(rows(instance)).toEqual(["Warden Ilsever", "create:the warden"]);
  });

  it("closes when the writer closes the brackets themselves", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[The Third Gate]]");

    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(false);
  });

  it("closes on a pipe, which a wikilink cannot carry either", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[the third|");

    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(false);
  });

  it("never offers an asset the same catalog carries", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[third");

    expect(rows(instance)).toEqual(["Third Gate Aspirants", "The Third Gate", "create:third"]);
  });

  it("leaves the literal brackets in the sentence when the menu is dismissed", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[thi");
    getWikilinkMenu(instance)?.dismiss();

    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(false);
    expect(instance.state.doc.textContent).toBe("[[thi");
  });

  it("inserts the chosen document as a wikilink", async () => {
    const { editor: instance } = mount();
    await type(instance, "[[the third");
    getWikilinkMenu(instance)?.chooseActive();

    expect(instance.state.doc.textContent).toBe("The Third Gate");
    expect(instance.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe(
      "[[The Third Gate]]",
    );
  });

  it("opens between the closers auto-pairing wrote for the second bracket", async () => {
    const { editor: instance } = mount();
    await keystrokes(instance, "[[");

    expect(instance.state.doc.textContent).toBe("[[]]");
    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(true);
    expect(rows(instance)).toEqual(["The Third Gate", "Third Gate Aspirants", "Warden Ilsever"]);
  });

  it("swallows those closers when the writer chooses a document", async () => {
    const { editor: instance } = mount();
    await keystrokes(instance, "[[the third");
    getWikilinkMenu(instance)?.chooseActive();

    expect(instance.state.doc.textContent).toBe("The Third Gate");
    expect(instance.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe(
      "[[The Third Gate]]",
    );
  });

  it("never opens inside a code fence", async () => {
    const { editor: instance } = mount("<pre><code></code></pre>");
    instance.commands.setTextSelection(1);
    await type(instance, "[[");

    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(false);
  });

  it("takes the menu down when the catalog is withdrawn under it", async () => {
    const { editor: instance, withdraw } = mount();
    await type(instance, "[[thi");
    withdraw();

    expect(getWikilinkMenu(instance)?.snapshot().open).toBe(false);
  });
});
