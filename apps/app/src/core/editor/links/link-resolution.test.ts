// @vitest-environment jsdom
/**
 * The three answers a link can get, and the fourth that is not an answer.
 *
 * The DOM assertions are load-bearing: the link surface's stylesheet reaches
 * the
 * anchor through `a:has([data-link-state="unresolved"])`, which only works
 * because ProseMirror renders an inline decoration inside the mark. A change
 * to that nesting is a silently unstyled unresolved link, so the shape is
 * asserted rather than assumed.
 */
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

import { createStandaloneEditorExtensions } from "../config";
import { getLinkResolution } from "./LinkSurfaceExtension";

let editor: Editor | null = null;
let pair: CollabPair | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  pair?.destroy();
  pair = null;
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

/**
 * The decorations are rebuilt only when something reached a link, so the
 * transactions that do NOT rebuild them are the ones with something to prove:
 * a peer's write, which arrives as a replacement of the whole document, and a
 * local edit somewhere else, which must carry them along instead.
 */
describe("what the drawing survives", () => {
  const LINKED = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Kael pressed" }] },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "The Second Gate",
            marks: [{ type: "link", attrs: { href: "[[The Second Gate]]" } }],
          },
        ],
      },
    ],
  };

  async function resolvedPair(): Promise<CollabPair> {
    pair = createCollabPair(LINKED);
    getLinkResolution(pair.local)?.registerResolver(async () => SECOND_GATE);
    await settle();
    expect(stateOf(pair.local)).toBe("resolved");
    return pair;
  }

  it("keeps the state through a peer's write, which replaces the whole document", async () => {
    const { local, peer, sync } = await resolvedPair();

    peer.commands.insertContentAt(1, "A collaborator typed here. ");
    sync();

    expect(local.state.doc.textContent).toContain("A collaborator typed here.");
    expect(stateOf(local)).toBe("resolved");
  });

  it("keeps the state through a peer's write inside the link's own text", async () => {
    const { local, peer, sync } = await resolvedPair();
    const linkStart = local.state.doc.resolve(local.state.doc.content.size - 1).start();

    peer.commands.insertContentAt(linkStart + 3, "!");
    sync();

    expect(stateOf(local)).toBe("resolved");
  });

  it("carries the state past an edit of its own in another paragraph", async () => {
    const target = editorWith(
      '<p>Kael pressed</p><p><a href="[[The Second Gate]]">The Second Gate</a></p>',
    );
    getLinkResolution(target)?.registerResolver(async () => SECOND_GATE);
    await settle();
    expect(stateOf(target)).toBe("resolved");

    target.commands.insertContentAt(3, "xyz");

    expect(stateOf(target)).toBe("resolved");
  });

  it("asks about a link the writer just made", async () => {
    const target = editorWith("<p>The Second Gate</p>");
    getLinkResolution(target)?.registerResolver(async () => SECOND_GATE);
    await settle();
    expect(stateOf(target)).toBeNull();

    target.commands.selectAll();
    target.commands.setLink({ href: "[[The Second Gate]]" });
    await settle();

    // The mark step moves nothing, so a hot path that only mapped positions
    // would keep the old set of hrefs and never ask about this one.
    expect(stateOf(target)).toBe("resolved");
  });
});
