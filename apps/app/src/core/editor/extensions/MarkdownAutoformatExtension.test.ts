// @vitest-environment jsdom
/**
 * The markdown autoformat truth table.
 *
 * Most of these rules are inherited from TipTap rather than written by
 * Meridian, which is exactly why they are pinned here: an upgrade that renames
 * a regex or drops a rule would otherwise silently take a trigger away from
 * the writer. Every case types real characters through the input-rule engine
 * and presses real keys through the keymap.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";

const live: Editor[] = [];

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

function openEditor(content = "<p></p>"): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: createStandaloneEditorExtensions(), content });
  live.push(editor);
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

function marksOnFirstText(editor: Editor): string[] {
  const text = editor.state.doc.firstChild?.firstChild;
  return text?.marks.map((mark) => mark.type.name) ?? [];
}

describe("block rules fire at their trigger", () => {
  const table: Array<[typed: string, outline: string]> = [
    ["# Chapter", 'heading:1("Chapter")'],
    ["## Scene", 'heading:2("Scene")'],
    ["### Beat", 'heading:3("Beat")'],
    ["> aside", 'blockquote("aside")'],
    ["- item", 'bullet_list("item")'],
    ["* item", 'bullet_list("item")'],
    ["1. item", 'ordered_list("item")'],
    ["---", 'horizontal_rule("") + paragraph("")'],
    ["```ts x", 'code_block:ts("x")'],
    ["``` x", 'code_block:none("x")'],
  ];

  for (const [typed, expected] of table) {
    it(`turns ${JSON.stringify(typed)} into ${expected}`, () => {
      const editor = openEditor();
      type(editor, typed);
      expect(outline(editor)).toBe(expected);
    });
  }

  it("opens an ordered list on the number the writer typed", () => {
    const editor = openEditor();
    type(editor, "7. seventh");

    // The schema calls GFM's start number `order`; TipTap's inherited rule
    // writes `start`, which the schema drops, so every list opened at one.
    expect(editor.state.doc.firstChild?.attrs.order).toBe(7);
    expect(editor.getHTML()).toContain('<ol start="7">');
  });
});

describe("mark rules fire at their trigger", () => {
  const table: Array<[typed: string, mark: string]> = [
    ["**bold**", "strong"],
    ["*emphasis*", "em"],
    ["~~struck~~", "strike"],
    ["`literal`", "code"],
  ];

  for (const [typed, mark] of table) {
    it(`turns ${JSON.stringify(typed)} into ${mark}`, () => {
      const editor = openEditor();
      type(editor, typed);
      expect(marksOnFirstText(editor)).toEqual([mark]);
    });
  }
});

describe("block rules fire only at a block start", () => {
  const midLine = [
    "prose # not a heading",
    "prose > not a quote",
    "prose - not a list",
    "prose 1. not a list",
    "prose --- not a rule",
    "prose ```ts not a fence",
  ];

  for (const typed of midLine) {
    it(`leaves ${JSON.stringify(typed)} as prose`, () => {
      const editor = openEditor();
      type(editor, typed);
      expect(outline(editor)).toBe(`paragraph(${JSON.stringify(typed)})`);
    });
  }
});

describe("nothing fires inside a code block", () => {
  const inert = ["# heading", "> quote", "- item", "1. item", "--- ", "```", "**bold** "];

  for (const typed of inert) {
    it(`leaves ${JSON.stringify(typed)} as code`, () => {
      const editor = openEditor();
      type(editor, "```ts ");
      type(editor, typed);
      expect(outline(editor)).toBe(`code_block:ts(${JSON.stringify(typed)})`);
    });
  }

  it("takes a fence closed by Enter as a newline, not a nested block", () => {
    const editor = openEditor();
    type(editor, "```ts ");
    type(editor, "```");
    press(editor, "Enter");
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("code_block");
  });
});

describe("code fences capture their language", () => {
  const table: Array<[info: string, language: string]> = [
    ["ts", "ts"],
    ["mermaid", "mermaid"],
    // Case-blind and punctuation-tolerant: TipTap's own `[a-z]+` rule matched
    // none of these, leaving the writer with literal backticks.
    ["Python", "python"],
    ["Mermaid", "mermaid"],
    ["c++", "c++"],
    ["ts-node", "ts-node"],
    ["objective-c", "objective-c"],
  ];

  for (const [info, language] of table) {
    it(`reads \`\`\`${info} as ${language}`, () => {
      const editor = openEditor();
      type(editor, `\`\`\`${info} `);
      expect(editor.state.doc.firstChild?.type.name).toBe("code_block");
      expect(editor.state.doc.firstChild?.attrs.language).toBe(language);
    });
  }

  it("gives a mermaid fence a plain code block, not a diagram", () => {
    const editor = openEditor();
    type(editor, "```mermaid ");
    type(editor, "graph TD;");
    expect(outline(editor)).toBe('code_block:mermaid("graph TD;")');
  });

  it("closes a pending fence on Enter as well as on space", () => {
    const editor = openEditor();
    type(editor, "```mermaid");
    expect(press(editor, "Enter")).toBe(true);
    expect(outline(editor)).toBe('code_block:mermaid("")');
  });

  it("leaves Enter alone when the block is not a pending fence", () => {
    const editor = openEditor();
    type(editor, "prose");
    expect(press(editor, "Enter")).toBe(true);
    expect(outline(editor)).toBe('paragraph("prose") + paragraph("")');
  });
});

describe("Backspace reverts the transform it just made", () => {
  const table: Array<[typed: string, restored: string]> = [
    ["# ", "# "],
    ["> ", "> "],
    ["- ", "- "],
    ["1. ", "1. "],
    ["```ts ", "```ts "],
  ];

  for (const [typed, restored] of table) {
    it(`restores ${JSON.stringify(restored)} after ${JSON.stringify(typed)}`, () => {
      const editor = openEditor();
      type(editor, typed);
      expect(press(editor, "Backspace")).toBe(true);
      expect(outline(editor)).toBe(`paragraph(${JSON.stringify(restored)})`);
    });
  }

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
