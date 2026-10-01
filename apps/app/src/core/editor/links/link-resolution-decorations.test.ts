// @vitest-environment jsdom
/** What the Editor draws for each answer the resolver gives, on a real editor. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { getLinkResolution } from "./LinkSurfaceExtension";
import type { InternalLinkResolver } from "./link-resolution";

const KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "manuscript",
  path: "cast/Kael.md",
  uri: "manuscript://cast/Kael.md",
  workId: null,
};

const live: Array<{ editor: Editor; host: HTMLElement }> = [];

afterEach(() => {
  for (const { editor, host } of live.splice(0)) {
    editor.destroy();
    host.remove();
  }
});

function drawn(
  resolver: InternalLinkResolver,
  { href = "[[Kael]]", baseUri }: { href?: string; baseUri?: string } = {},
): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: `<p>Ask <a href="${href}">Kael</a> first.</p>`,
  });
  live.push({ editor, host: element });
  getLinkResolution(editor)?.registerResolver(resolver, { baseUri });
  return editor;
}

/** What the decoration inside the link's anchor says. */
function drawing(editor: Editor) {
  const span = editor.view.dom.querySelector("a [data-link-chip-part]");
  return {
    state: span?.getAttribute("data-link-state") ?? null,
    chip: span?.getAttribute("data-link-chip-part") ?? null,
    icon: span?.getAttribute("data-link-chip-icon") ?? null,
  };
}

const ANSWERS: Array<[string, InternalLinkResolver, string, string]> = [
  ["resolved", async () => KAEL, "filled", "manuscript"],
  ["unresolved", async () => null, "dashed", "file-plus"],
  // Several documents carry the name: a link that leads somewhere, never drawn
  // as one with nothing behind it.
  ["ambiguous", async () => "ambiguous", "filled", "file"],
];

describe("link resolution decorations", () => {
  it.each(ANSWERS)("draws a %s answer as a %s chip", async (state, resolver, chip, icon) => {
    const editor = drawn(resolver);

    await vi.waitFor(() => expect(drawing(editor)).toEqual({ state, chip, icon }));
  });

  it("draws pending while the question is out", async () => {
    const editor = drawn(() => new Promise(() => {}));

    await vi.waitFor(() =>
      expect(drawing(editor)).toEqual({ state: "pending", chip: "filled", icon: "file" }),
    );
  });

  it("draws a link that could not be checked as filled, never as missing", async () => {
    const editor = drawn(async () => {
      throw new Error("offline");
    });

    await vi.waitFor(() =>
      expect(drawing(editor)).toEqual({ state: null, chip: "filled", icon: "file" }),
    );
  });

  it("gives a relative link the family of the document holding it", async () => {
    const editor = drawn(async () => null, {
      href: "./cast.md",
      baseUri: "kb://characters/index.md",
    });

    await vi.waitFor(() =>
      expect(drawing(editor)).toEqual({ state: "unresolved", chip: "dashed", icon: "kb" }),
    );
  });

  it("draws nothing on an external link", async () => {
    const editor = drawn(async () => KAEL, { href: "https://example.com/" });
    await Promise.resolve();

    expect(editor.view.dom.querySelector("[data-link-chip-part]")).toBeNull();
  });
});
