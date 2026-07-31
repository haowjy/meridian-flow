// @vitest-environment jsdom
/**
 * The `@` trigger against a real editor.
 *
 * What these hold down is everything `@` does NOT inherit from `[[`: one
 * character is prose until a boundary and a name make it a request, the menu
 * mixes two kinds of thing, and the two kinds write two different objects — a
 * link mark for a page, an inline picture for an asset. The overlap with `[[`
 * is the point of the last group: a document picked here has to land byte for
 * byte where a `[[` pick lands, or the manuscript carries two spellings of one
 * meaning.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { getWikilinkMenu } from "../wikilink";
import { getAtReferenceMenu } from "./AtReferenceExtension";
import {
  type AtReferenceCatalog,
  type AtReferenceItem,
  atReferenceItems,
} from "./at-reference-catalog";

const live: Editor[] = [];

afterEach(() => {
  for (const instance of live.splice(0)) instance.destroy();
});

const CATALOG: AtReferenceCatalog = {
  label: "Reference a document or picture",
  groupLabels: { document: "Documents", asset: "Pictures" },
  candidates: [
    document("The Third Gate", "Chapters"),
    document("Warden Ilsever", "Characters"),
    {
      kind: "asset",
      name: "third-gate.png",
      location: "Assets",
      assetDocumentId: "asset-third-gate",
      path: "/assets/third-gate.png",
      fileType: "image",
    },
    {
      kind: "asset",
      name: "gate-plans.pdf",
      location: "Assets",
      assetDocumentId: "asset-plans",
      path: "/assets/gate-plans.pdf",
      fileType: "pdf",
    },
  ],
};

function document(title: string, location: string) {
  return {
    kind: "document",
    title,
    location,
    documentId: `document-${title}`,
    uri: `manuscript://${title}.md`,
  } as const;
}

/** Both reference lanes, because the document rows they write must agree. */
function mount(content = "<p></p>") {
  let catalog: AtReferenceCatalog | null = CATALOG;
  const instance = new Editor({
    extensions: createStandaloneEditorExtensions({
      atReferences: { catalog: () => catalog },
      wikilinks: { catalog: () => catalog },
    }),
    content,
  });
  live.push(instance);
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

const menu = (instance: Editor) => getAtReferenceMenu(instance);

const label = (item: AtReferenceItem) =>
  item.kind === "create" ? `create:${item.name}` : `${item.kind}:${item.name}`;

const rows = (instance: Editor) => menu(instance)?.snapshot().items.map(label);

describe("where `@` opens against a live editor", () => {
  it("opens after a space and offers documents and pictures together", async () => {
    const { editor } = mount();
    await type(editor, "She checked the seal against @third");

    expect(menu(editor)?.snapshot().open).toBe(true);
    expect(rows(editor)).toEqual([
      "asset:third-gate.png",
      "document:The Third Gate",
      "create:third",
    ]);
  });

  it("stays out of an address, which is where a lone `@` usually sits", async () => {
    const { editor } = mount();
    await type(editor, "Write to ilsever@third");

    expect(menu(editor)?.snapshot().open).toBe(false);
  });

  it("leaves the writer alone when the `@` is a word of its own", async () => {
    const { editor } = mount();
    // "meet @ noon" is a legal trigger POSITION — the space before the `@` is
    // exactly what makes it one — so the space after it has to be the refusal.
    await type(editor, "They meet @ noon");

    expect(menu(editor)?.snapshot().open).toBe(false);
    expect(editor.state.doc.textContent).toBe("They meet @ noon");
  });

  it("keeps filtering through the spaces a document title has", async () => {
    const { editor } = mount();
    await type(editor, "@the third");

    expect(rows(editor)).toEqual(["document:The Third Gate", "create:the third"]);
  });

  it("closes rather than answer a query nobody typed in good faith", async () => {
    const { editor } = mount();
    await type(editor, `@${"z".repeat(81)}`);

    expect(menu(editor)?.snapshot().open).toBe(false);
    expect(editor.state.doc.textContent.startsWith("@zzz")).toBe(true);
  });

  it("never opens inside a code fence", async () => {
    const { editor } = mount("<pre><code></code></pre>");
    editor.commands.setTextSelection(1);
    await type(editor, "@");

    expect(menu(editor)?.snapshot().open).toBe(false);
  });

  it("leaves the literal `@` in the sentence when the menu is dismissed", async () => {
    const { editor } = mount();
    await type(editor, "@thi");
    menu(editor)?.dismiss();

    expect(menu(editor)?.snapshot().open).toBe(false);
    expect(editor.state.doc.textContent).toBe("@thi");
  });

  it("takes the menu down when the catalog is withdrawn under it", async () => {
    const { editor, withdraw } = mount();
    await type(editor, "@thi");
    withdraw();

    expect(menu(editor)?.snapshot().open).toBe(false);
  });
});

describe("what the `@` menu offers", () => {
  it("carries the host's headings, and gathers the kinds while the writer browses", async () => {
    const { editor } = mount();
    await type(editor, "@");

    expect(menu(editor)?.snapshot().meta).toEqual({
      groupLabels: { document: "Documents", asset: "Pictures" },
    });
    // An empty query matches everything equally, so the kinds arrive already
    // gathered: documents first, then what stands beside them.
    expect(rows(editor)).toEqual([
      "document:The Third Gate",
      "document:Warden Ilsever",
      "asset:third-gate.png",
    ]);
  });

  it("names the listbox with the host's own label", async () => {
    const { editor } = mount();
    await type(editor, "@thi");

    expect(menu(editor)?.snapshot().label).toBe("Reference a document or picture");
  });

  it("withholds an asset the prose has no object for", () => {
    // The composer's `@` will name a PDF happily; in a chapter there is nothing
    // to insert for one, so this menu does not offer it. The create row is all
    // that is left, because a document by that name could still be written.
    expect(atReferenceItems(CATALOG, "plans").map(label)).toEqual(["create:plans"]);
  });

  it("offers no way to create a picture from a name", () => {
    // The create row is a document row: nothing conjures an image out of a
    // word, so a query that only an asset could answer offers no second door.
    expect(atReferenceItems(CATALOG, "third-gate.png").map(label)).toEqual([
      "asset:third-gate.png",
      "create:third-gate.png",
    ]);
    expect(atReferenceItems({ ...CATALOG, candidates: [] }, " noon")).toEqual([]);
  });
});

describe("what choosing an `@` row writes", () => {
  it("writes a document exactly as `[[` writes it", async () => {
    const { editor } = mount();
    await type(editor, "@the third");
    menu(editor)?.chooseActive();

    const { editor: other } = mount();
    await type(other, "[[the third");
    getWikilinkMenu(other)?.chooseActive();

    expect(editor.state.doc.toJSON()).toEqual(other.state.doc.toJSON());
    expect(editor.state.doc.textContent).toBe("The Third Gate");
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe(
      "[[The Third Gate]]",
    );
  });

  it("writes an asset as the inline picture the upload path lands", async () => {
    const { editor } = mount();
    await type(editor, "She unrolled @third-gate.png");
    menu(editor)?.chooseActive();

    const [sentence, picture] = editor.state.doc.toJSON().content[0].content;
    expect(sentence).toEqual({ type: "text", text: "She unrolled " });
    expect(picture.type).toBe("image");
    // The stable ref and an alt read off the filename: what an upload writes,
    // minus the upload.
    expect(picture.attrs).toMatchObject({ src: "asset:asset-third-gate", alt: "third gate" });
  });

  it("leaves the closer of a pair the writer opened themselves", async () => {
    const { editor } = mount();
    // `@` opens no pair of its own, so the `)` after the caret belongs to the
    // parenthesis the writer typed — unlike `[[`, whose own second bracket
    // wrote the `]]` a pick has to swallow.
    await keystrokes(editor, "(see @the third");
    expect(editor.state.doc.textContent).toBe("(see @the third)");

    menu(editor)?.chooseActive();
    expect(editor.state.doc.textContent).toBe("(see The Third Gate)");
  });
});
