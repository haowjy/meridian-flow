// @vitest-environment jsdom
/**
 * Writing an object's own words, one keystroke at a time.
 *
 * The field popover has no draft: every keystroke is a `setNodeMarkup`, which
 * is what makes undo the way back and lets a collaborator watch a caption
 * arrive. That puts one requirement on this command that a form with a Save
 * button never has — **it may not normalize what the writer is still typing.**
 * A trim per keystroke ate the space bar: " with lanterns" arrived as
 * "withlanterns", because each space was trimmed off the end before the next
 * letter could follow it.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { setObjectField } from "./object-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const FIGURE: JSONContent = {
  type: "figure",
  attrs: { src: "asset:1", alt: null, label: null, caption: "" },
};

function mountFigure(): { editor: Editor; pos: number } {
  const mounted = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content: [FIGURE, { type: "paragraph" }] },
  });
  editor = mounted;
  let pos: number | null = null;
  mounted.state.doc.descendants((node, at) => {
    if (pos === null && node.type.name === "figure") pos = at;
    return pos === null;
  });
  if (pos === null) throw new Error("no figure in the fixture");
  return { editor: mounted, pos };
}

function figureAttrs(instance: Editor): Record<string, unknown> {
  let attrs: Record<string, unknown> | null = null;
  instance.state.doc.descendants((node) => {
    if (!attrs && node.type.name === "figure") attrs = node.attrs;
    return attrs === null;
  });
  if (!attrs) throw new Error("the figure is gone");
  return attrs;
}

/**
 * What the writer typed, arriving the way the popover's controlled input reports
 * it: one keystroke at a time, appended to the value the DOCUMENT currently
 * holds. That last part is the whole test — a controlled input renders what the
 * document says, so anything this command normalizes is gone before the next
 * keystroke can build on it.
 */
function typeInto(instance: Editor, pos: number, text: string): void {
  for (const character of text) {
    const shown = figureAttrs(instance).alt;
    setObjectField(instance, pos, "alt", `${typeof shown === "string" ? shown : ""}${character}`);
  }
}

describe("writing an object's field", () => {
  it("keeps the spaces the writer types", () => {
    const { editor: instance, pos } = mountFigure();

    typeInto(instance, pos, "Lanterns on the terrace");

    expect(figureAttrs(instance).alt).toBe("Lanterns on the terrace");
  });

  it("reads a field the writer emptied as absent", () => {
    const { editor: instance, pos } = mountFigure();

    setObjectField(instance, pos, "alt", "   ");

    // Nullable in the schema and absent on the wire: an alt of three spaces is
    // an alt nobody wrote.
    expect(figureAttrs(instance).alt).toBeNull();
  });

  it("leaves the caption a plain string, which is what the schema says it is", () => {
    const { editor: instance, pos } = mountFigure();

    setObjectField(instance, pos, "caption", "The terrace at dusk ");

    expect(figureAttrs(instance).caption).toBe("The terrace at dusk ");
  });
});
