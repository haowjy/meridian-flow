// @vitest-environment jsdom
/**
 * What a figure shows when nobody is pointing at it.
 *
 * The manuscript at rest is the picture and its caption. Alt text, the label,
 * and the caption are VERBS — they live behind the object surface's ⋮ like
 * every other image verb (§5.6, ruling 8) — so the node view carries no form
 * and reserves no room for one. A permanent form under every figure is height
 * the chapter pays for on every render, and a second owner for attributes the
 * object surface already writes.
 */
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "./config";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let editor: Editor | null = null;
let root: Root | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

function mountFigure(attrs: Record<string, unknown>): void {
  const element = document.createElement("div");
  document.body.append(element);
  const mounted = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "figure", attrs },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    },
  });
  editor = mounted;
  root = createRoot(element);
  act(() => root?.render(<EditorContent editor={mounted} />));
}

function figureElement(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".meridian-figure-node");
  if (!found) throw new Error("no figure in the page");
  return found;
}

describe("a figure in an editable document", () => {
  it("shows the picture and its caption, and no form", () => {
    mountFigure({
      src: "https://example.test/terrace.png",
      alt: "The terrace at dusk",
      label: "fig:terrace",
      caption: "The terrace at dusk",
    });

    const figure = figureElement();
    expect(figure.querySelector("img")?.getAttribute("alt")).toBe("The terrace at dusk");
    expect(figure.textContent).toContain("The terrace at dusk");
    expect(figure.querySelectorAll("input, textarea")).toHaveLength(0);
  });

  it("says nothing about a caption it does not have", () => {
    mountFigure({ src: "https://example.test/terrace.png", alt: null, label: null, caption: "" });

    const figure = figureElement();
    expect(figure.querySelectorAll("input, textarea")).toHaveLength(0);
    // Not a prompt in the chapter: an empty caption is an empty caption, and
    // the verb that fills it is in the ⋮.
    expect(figure.textContent).toBe("");
  });
});
