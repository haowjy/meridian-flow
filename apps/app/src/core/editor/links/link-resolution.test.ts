// @vitest-environment jsdom
/**
 * The three answers a link can get, and the fourth that is not an answer.
 *
 * The DOM assertions are load-bearing: the CSS in `editor.css` reaches the
 * anchor through `a:has([data-link-state="unresolved"])`, which only works
 * because ProseMirror renders an inline decoration inside the mark. A change
 * to that nesting is a silently unstyled unresolved link, so the shape is
 * asserted rather than assumed.
 */
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { getLinkResolution } from "./LinkSurfaceExtension";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const SECOND_GATE: ResolvedDocumentLink = {
  documentId: "doc-1",
  title: "The Second Gate",
  scheme: "manuscript",
  path: "chapters/the-second-gate.md",
  uri: "manuscript://chapters/the-second-gate.md",
  workId: null,
};

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

/** Lets the queued questions and the redraw they trigger both land. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const stateOf = (target: Editor) =>
  target.view.dom.querySelector("a [data-link-state]")?.getAttribute("data-link-state") ?? null;

describe("what an internal link is drawn as", () => {
  it("says nothing at all until a resolver registers", async () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">The Second Gate</a></p>');
    await settle();

    expect(stateOf(target)).toBeNull();
  });

  it("marks a link the project knows as resolved", async () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">The Second Gate</a></p>');
    getLinkResolution(target)?.registerResolver(async () => SECOND_GATE);
    await settle();

    expect(stateOf(target)).toBe("resolved");
  });

  it("marks a link with nothing behind it as unresolved, inside the anchor", async () => {
    const target = editorWith('<p><a href="[[Warden Ilsever]]">Warden Ilsever</a></p>');
    getLinkResolution(target)?.registerResolver(async () => null);
    await settle();

    expect(stateOf(target)).toBe("unresolved");
    // What the `:has()` rule needs: the state sits on a child of the anchor.
    expect(target.view.dom.querySelector("a > [data-link-state]")).not.toBeNull();
  });

  it("leaves a link it could not ask about looking like any other link", async () => {
    const target = editorWith('<p><a href="[[Warden Ilsever]]">Warden Ilsever</a></p>');
    getLinkResolution(target)?.registerResolver(async () => {
      throw new Error("offline");
    });
    await settle();

    // An unanswered question is not the same as an answer of "nothing", and
    // drawing it as one would tell the writer their document is missing.
    expect(stateOf(target)).toBeNull();
  });

  it("never asks about an external link", async () => {
    const target = editorWith('<p><a href="https://example.com">a forum thread</a></p>');
    const resolve = vi.fn(async () => null);
    getLinkResolution(target)?.registerResolver(resolve);
    await settle();

    expect(resolve).not.toHaveBeenCalled();
    expect(stateOf(target)).toBeNull();
  });

  it("asks once for a target that appears twice, however it is spelled", async () => {
    const target = editorWith(
      '<p><a href="[[The Second Gate]]">The Second Gate</a> and ' +
        '<a href="[[ The Second Gate ]]">again</a></p>',
    );
    const resolve = vi.fn(async () => SECOND_GATE);
    getLinkResolution(target)?.registerResolver(resolve);
    await settle();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(target.view.dom.querySelectorAll('a [data-link-state="resolved"]')).toHaveLength(2);
  });

  it("asks again about a document the project just gained", async () => {
    const target = editorWith('<p><a href="[[Warden Ilsever]]">Warden Ilsever</a></p>');
    let exists = false;
    const resolution = getLinkResolution(target);
    resolution?.registerResolver(async () => (exists ? SECOND_GATE : null));
    await settle();
    expect(stateOf(target)).toBe("unresolved");

    exists = true;
    resolution?.refresh();
    await settle();

    expect(stateOf(target)).toBe("resolved");
  });

  it("hands a click the answer it is waiting for", async () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">The Second Gate</a></p>');
    const resolution = getLinkResolution(target);
    resolution?.registerResolver(async () => SECOND_GATE);

    await expect(resolution?.resolve("[[The Second Gate]]")).resolves.toEqual({
      state: "resolved",
      document: SECOND_GATE,
    });
  });
});
