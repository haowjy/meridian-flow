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

function drawn(resolver: InternalLinkResolver): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: '<p>Ask <a href="[[Kael]]">Kael</a> first.</p>',
  });
  live.push({ editor, host: element });
  getLinkResolution(editor)?.registerResolver(resolver);
  return editor;
}

function state(editor: Editor): string | null | undefined {
  return editor.view.dom.querySelector("a [data-link-state]")?.getAttribute("data-link-state");
}

const ANSWERS: Array<[string, InternalLinkResolver]> = [
  ["resolved", async () => KAEL],
  ["unresolved", async () => null],
  // Several documents carry the name: a link that leads somewhere, never drawn
  // as one with nothing behind it.
  ["ambiguous", async () => "ambiguous"],
];

describe("link resolution decorations", () => {
  it.each(ANSWERS)("draws a %s answer", async (expected, resolver) => {
    const editor = drawn(resolver);

    await vi.waitFor(() => expect(state(editor)).toBe(expected));
  });

  it("draws pending while the question is out", async () => {
    const editor = drawn(() => new Promise(() => {}));

    await vi.waitFor(() => expect(state(editor)).toBe("pending"));
  });
});
