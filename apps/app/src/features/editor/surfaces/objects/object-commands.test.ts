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
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { copyText, setObjectField } from "./object-commands";

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

/**
 * The clipboard reaches these verbs through the feature's one adapter, and verb
 * feedback translates the browser's own error names into the writer's sentence
 * ("the browser blocked the clipboard" reads differently from "that did not
 * work"). So a refusal has to arrive as the error the browser threw, not as a
 * summary of it.
 */
describe("a copy the browser refuses", () => {
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  afterEach(() => {
    if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  function stubClipboard(clipboard: Partial<Clipboard>): void {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  }

  it("hands the browser's own refusal to the feedback that reads its name", async () => {
    const denial = new DOMException("blocked", "NotAllowedError");
    stubClipboard({ writeText: vi.fn().mockRejectedValue(denial) });

    await expect(copyText("flowchart LR")).rejects.toBe(denial);
  });

  it("still fails loudly where the browser offers no clipboard at all", async () => {
    stubClipboard({});

    await expect(copyText("flowchart LR")).rejects.toThrow();
  });

  it("resolves quietly when the words are on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    await expect(copyText("flowchart LR")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("flowchart LR");
  });
});
