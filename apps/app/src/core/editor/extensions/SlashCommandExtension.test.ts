// @vitest-environment jsdom
/** Behavioral contract for slash matching, activation boundaries, and keyboard selection. */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import {
  filterSlashCommandItems,
  type SlashCommandItem,
  slashCommandPluginKey,
} from "./SlashCommandExtension";

const ITEMS = [
  { id: "scene-break", label: "Scene break", aliases: ["divider", "hr", "rule", "break"] },
  { id: "heading", label: "Heading", aliases: ["title", "h1", "h2", "section"] },
  { id: "table", label: "Table", aliases: ["grid", "stat block", "status", "litrpg"] },
] satisfies SlashCommandItem[];

const editors: Editor[] = [];

function createEditor(content: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    content,
    extensions: createStandaloneEditorExtensions({
      slashCommands: { items: ITEMS, menuLabel: "Insert block" },
    }),
  });
  editors.push(editor);
  return editor;
}

function suggestionActive(editor: Editor) {
  return Boolean(slashCommandPluginKey.getState(editor.state)?.active);
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const element = editor.view.dom.parentElement;
    editor.destroy();
    element?.remove();
  }
});

describe("slash command filtering", () => {
  it("fuzzy matches labels and aliases while preserving catalog order for ties", () => {
    expect(filterSlashCommandItems(ITEMS, "stbl").map(({ id }) => id)).toEqual(["table"]);
    expect(filterSlashCommandItems(ITEMS, "br").map(({ id }) => id)).toEqual(["scene-break"]);
    expect(filterSlashCommandItems(ITEMS, "").map(({ id }) => id)).toEqual([
      "scene-break",
      "heading",
      "table",
    ]);
  });
});

describe("slash command activation", () => {
  it("activates only at the start of an empty paragraph", () => {
    const empty = createEditor("<p></p>");
    empty.commands.insertContent("/");
    expect(suggestionActive(empty)).toBe(true);

    const prose = createEditor("<p>either</p>");
    prose.commands.focus("end");
    prose.commands.insertContent("/or");
    expect(suggestionActive(prose)).toBe(false);

    const beforeProse = createEditor("<p>existing prose</p>");
    beforeProse.commands.focus("start");
    beforeProse.commands.insertContent("/");
    expect(suggestionActive(beforeProse)).toBe(false);
  });

  it("does not activate inside a table cell", () => {
    const editor = createEditor("<p></p>");
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
    editor.commands.insertContent("/");
    expect(suggestionActive(editor)).toBe(false);
  });

  it("Escape dismisses the menu without deleting the typed text", () => {
    const editor = createEditor("<p></p>");
    editor.commands.insertContent("/hea");
    expect(suggestionActive(editor)).toBe(true);

    editor.view.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(suggestionActive(editor)).toBe(false);
    expect(editor.getText()).toBe("/hea");
  });

  it("Enter replaces the query paragraph with the selected block", async () => {
    const editor = createEditor("<p></p>");
    editor.commands.insertContent("/hea");
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".meridian-slash-menu__item")).toHaveLength(1),
    );
    editor.view.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(editor.getJSON()).toMatchObject({
      content: [{ type: "heading", attrs: { level: 1 } }],
    });
  });
});
