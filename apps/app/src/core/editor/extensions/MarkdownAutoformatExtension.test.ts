// @vitest-environment jsdom
/** Meridian-owned fence parsing, ordered-list start and input-rule undo contracts. */
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";

const live: StandaloneEditor[] = [];

afterEach(() => {
  for (const fixture of live.splice(0)) fixture.destroy();
});

function openEditor(content = "<p></p>"): Editor {
  const fixture = createStandaloneEditor({ content });
  live.push(fixture);
  const { editor } = fixture;
  return editor;
}

/** Type character by character the way a browser reports composition-free input. */
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

/** A compact block outline: `heading:2("Chapter")`, `code_block:mermaid()`. */
function outline(editor: Editor): string {
  const blocks: string[] = [];
  editor.state.doc.forEach((node) => {
    const detail =
      node.type.name === "heading"
        ? `:${node.attrs.level}`
        : node.type.name === "code_block"
          ? `:${node.attrs.language ?? "none"}`
          : "";
    blocks.push(`${node.type.name}${detail}(${JSON.stringify(node.textContent)})`);
  });
  return blocks.join(" + ");
}

describe("block rules fire at their trigger", () => {
  it("opens an ordered list on the number the writer typed", () => {
    const editor = openEditor();
    type(editor, "7. seventh");

    // The schema calls GFM's start number `order`; TipTap's inherited rule
    // writes `start`, which the schema drops, so every list opened at one.
    expect(editor.state.doc.firstChild?.attrs.order).toBe(7);
    expect(editor.getHTML()).toContain('<ol start="7">');
  });
});

describe("code fences capture their language", () => {
  const table: Array<[fence: string, info: string, language: string | null]> = [
    ["~~~", "aa~bb", "aa~bb"],
  ];

  for (const [fence, info, language] of table) {
    it(`reads ${fence}${info} as ${language ?? "no language"}`, () => {
      const editor = openEditor();
      type(editor, `${fence}${info} `);
      expect(editor.state.doc.firstChild?.type.name).toBe("code_block");
      expect(editor.state.doc.firstChild?.attrs.language).toBe(language);
    });
  }
});

describe("Backspace reverts the transform it just made", () => {
  // Enter is a key, not a character: the engine restores it as a literal
  // newline, which is invisible in a paragraph and would ship in the writer's
  // prose.
  it("restores the source of a fence closed by Enter, with no newline in it", () => {
    const editor = openEditor();
    type(editor, "```mermaid");
    press(editor, "Enter");
    expect(press(editor, "Backspace")).toBe(true);
    expect(outline(editor)).toBe('paragraph("```mermaid")');
  });

  it("leaves Backspace alone when the last keystroke transformed nothing", () => {
    const editor = openEditor();
    type(editor, "prose");
    // Refusing is what keeps the rest of the Backspace chain reachable; an
    // ordinary character delete is the browser's own, and no keymap claims it.
    expect(press(editor, "Backspace")).toBe(false);
    expect(outline(editor)).toBe('paragraph("prose")');
  });
});
