// @vitest-environment jsdom
/**
 * The Editor's `@` with link-ahead: a sentence after `@` that names no document
 * still ends in a new paragraph on Enter, and the link-ahead row stays one
 * arrow away.
 */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "@meridian/resource-replica";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { getAtReferenceMenu } from "./AtReferenceExtension";

const PROJECT = "01900000-0000-7000-8000-000000000002";
const scope = { kind: "project", projectId: PROJECT } as CatalogScope;

function view(): CatalogCacheView {
  return {
    scope,
    generation: "1",
    appliedRevision: "1",
    observedHeadRevision: "1",
    cursor: "",
    entries: new Map(),
    invalidatedEntryIds: new Set(),
    childIdsByParentId: new Map(),
    sourceIdsByScheme: new Map(),
  };
}

const live: Editor[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

function mount(): Editor {
  const catalog = view();
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    content: "<p></p>",
    extensions: createStandaloneEditorExtensions({
      atReferences: {
        catalog: () => ({
          port: {
            subscribe: () => () => {},
            status: () => "ready",
            read: () => catalog,
            acquire: async () => catalog,
          },
          openContext: () => ({ warmScopes: [scope] }),
          label: "Reference a file",
          holderUri: "manuscript://volume-1/chapter-2.md",
          linkAhead: (name) => ({ uri: `manuscript://volume-1/${name}.md` }),
        }),
      },
    }),
  });
  live.push(editor);
  editor.commands.focus();
  return editor;
}

function type(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    const handled = editor.view.someProp("handleTextInput", (handleTextInput) =>
      handleTextInput(editor.view, from, to, character, insert),
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

function press(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return (
    editor.view.someProp("handleKeyDown", (handleKeyDown) => handleKeyDown(editor.view, event)) ??
    false
  );
}

const links = (editor: Editor) => editor.view.dom.querySelectorAll("a").length;

describe("Enter after an `@` sentence", () => {
  it("makes a new paragraph when the sentence names no document", () => {
    const editor = mount();
    type(editor, "@Kael meet me at the gate");
    const menu = getAtReferenceMenu(editor);
    expect(menu?.snapshot().items.map((row) => row.kind)).toEqual(["link-ahead"]);

    press(editor, "Enter");

    expect(links(editor)).toBe(0);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.textContent).toBe("@Kael meet me at the gate");
  });
});
