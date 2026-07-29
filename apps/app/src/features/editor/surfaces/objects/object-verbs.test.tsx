// @vitest-environment jsdom
/**
 * What the ⋮ offers, per object.
 *
 * One surface owns the verbs of every registered object here, and what a given
 * object gets is a read of its registration rather than a branch on its node
 * type: a diagram offers its source, an image offers its alt text and a
 * replacement, and a figure offers the caption and label it shows under the
 * picture. The right-click is the door these drive, because it is the one that
 * needs no hover timing to open.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/core/editor/mermaid-render", () => ({
  renderMermaid: async () => "<svg data-fake-diagram></svg>",
}));

const { ObjectControls } = await import("./ObjectControls");

installJsdomLayout();

const FIGURE = {
  type: "figure",
  attrs: {
    src: "https://example.test/terrace.png",
    alt: "The terrace",
    label: null,
    caption: "The terrace at dusk",
  },
};

const IMAGE_PARAGRAPH = {
  type: "paragraph",
  content: [
    { type: "text", text: "before " },
    { type: "image", attrs: { src: "https://example.test/lantern.png", alt: "A lantern" } },
  ],
};

const DIAGRAM = {
  type: "code_block",
  attrs: { language: "mermaid" },
  content: [{ type: "text", text: "flowchart LR\nA --> B" }],
};

let pair: CollabPair | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  pair = createCollabPair({
    type: "doc",
    content: [FIGURE, IMAGE_PARAGRAPH, DIAGRAM, { type: "paragraph" }],
  });
  document.body.append(pair.local.view.dom);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  pair?.destroy();
  pair = null;
  document.body.replaceChildren();
});

/** The verbs a right-click on `selector` opens, in the order they are offered. */
function verbsAt(selector: string): string[] {
  if (!pair) throw new Error("no pair");
  const editor = pair.local;
  act(() => root?.render(<ObjectControls editor={editor} />));

  const element = editor.view.dom.querySelector(selector);
  if (!element) throw new Error(`no ${selector} in the page`);
  act(() => {
    element.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
  });

  return [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map(
    (item) => item.textContent ?? "",
  );
}

describe("the object ⋮", () => {
  it("gives a figure its alt text, a replacement, and the caption it shows", () => {
    const verbs = verbsAt("figure");

    expect(verbs).toContain("Alt text");
    expect(verbs).toContain("Replace image");
    expect(verbs).toContain("Caption");
    expect(verbs).toContain("Label");
    expect(verbs).toContain("Download image");
    expect(verbs).toContain("Delete");
    // A figure is not a diagram: there is no source to edit.
    expect(verbs).not.toContain("Edit source");
  });

  it("gives an inline picture alt text and a replacement, and no caption of its own", () => {
    const verbs = verbsAt("img[alt='A lantern']");

    expect(verbs).toContain("Alt text");
    expect(verbs).toContain("Replace image");
    // The inline image node carries no caption or label in the schema, so the
    // surface offers neither: the fields come from the registration.
    expect(verbs).not.toContain("Caption");
    expect(verbs).not.toContain("Label");
  });

  it("gives a diagram its source and no image metadata", () => {
    const verbs = verbsAt("pre");

    expect(verbs).toContain("Edit source");
    expect(verbs).not.toContain("Alt text");
    expect(verbs).not.toContain("Replace image");
  });
});
