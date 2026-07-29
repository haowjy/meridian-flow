// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { getLinkSurface } from "./LinkSurfaceExtension";

let editor: Editor | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  // jsdom has no layout, so ProseMirror's own hit-testing throws. The link
  // claim resolves its position from the DOM, never from coordinates.
  document.elementFromPoint = () => null;
  host = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

const TWO_LINKS =
  '<p><a href="https://one.test">first</a> gap <a href="https://two.test">second</a></p>';

/**
 * Mounted in the document on purpose: the kernel routes right-clicks from a
 * capture-phase listener on `document`, which a detached editor never reaches.
 */
function editorWith(content: string): Editor {
  editor = new Editor({
    element: host ?? undefined,
    extensions: createStandaloneEditorExtensions(),
    content,
  });
  return editor;
}

function rightClick(target: Editor, index: number): void {
  const anchor = target.view.dom.querySelectorAll("a")[index];
  if (!(anchor instanceof HTMLElement)) throw new Error("link was not rendered");
  anchor.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
  );
}

function menuOf(target: Editor) {
  return getLinkSurface(target)?.state.menu ?? null;
}

/**
 * The menu is aimed at the link the pointer hit, and it stays open while the
 * document moves under it: a peer types, an AI write lands, the writer reads
 * the menu for a second. Every verb on it rewrites a range, so a range that
 * stopped describing the writer's link is a verb aimed at someone else's
 * sentence.
 */
describe("the link menu keeps its aim", () => {
  it("opens on the link the pointer hit", () => {
    const target = editorWith(TWO_LINKS);

    rightClick(target, 1);

    expect(menuOf(target)).toMatchObject({
      anchor: { from: 11, to: 17 },
      href: "https://two.test",
    });
  });

  it("travels with its link when a peer types above it", () => {
    const target = editorWith(TWO_LINKS);
    rightClick(target, 1);

    target.view.dispatch(target.state.tr.insertText("ZZZZZZ", 1));

    expect(menuOf(target)).toMatchObject({
      anchor: { from: 17, to: 23 },
      href: "https://two.test",
    });
    // The proof that matters: the range still covers the word it was opened on.
    expect(target.state.doc.textBetween(17, 23)).toBe("second");
  });

  it("closes when its link is deleted rather than acting on what slid into place", () => {
    const target = editorWith(TWO_LINKS);
    rightClick(target, 1);

    target.view.dispatch(target.state.tr.delete(11, 17));

    expect(menuOf(target)).toBeNull();
  });

  it("closes when a peer changes the destination it was opened for", () => {
    const target = editorWith(TWO_LINKS);
    rightClick(target, 1);

    const link = target.state.schema.marks.link;
    target.view.dispatch(
      target.state.tr
        .removeMark(11, 17, link)
        .addMark(11, 17, link.create({ href: "https://three.test", title: null })),
    );

    // Open and Copy would otherwise promise a destination that is no longer
    // there. Re-aiming silently would be worse than closing.
    expect(menuOf(target)).toBeNull();
  });

  it("closes when the whole block holding its link goes", () => {
    const target = editorWith(`${TWO_LINKS}<p>after</p>`);
    rightClick(target, 1);

    target.view.dispatch(target.state.tr.delete(0, 19));

    expect(menuOf(target)).toBeNull();
  });
});
