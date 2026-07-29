/**
 * When the manuscript may have moved.
 *
 * Every floating thing in the editor asks the same question, and getting the
 * list of answers wrong is invisible until a writer scrolls: the block handle
 * kept its own shorter list for a while and stranded at its old viewport top on
 * every scroll. So the list lives here once, and both halves of the chrome
 * kernel use it — the React surfaces to re-measure their anchors, the kernel
 * extension to re-ask what is under a pointer that never moved.
 *
 * Four sources, and the transaction is the one a surface forgets: an element
 * that keeps its size and its identity still travels when a block above it
 * grows, when the writer moves it with Alt+Arrow, or when a peer's write lands
 * three paragraphs up. A ResizeObserver on the anchor sees none of those, so a
 * surface watching only itself paints over whatever slid into its old corner.
 *
 * The manuscript's own root is observed alongside the anchor for the layout
 * that changes with no transaction at all: a diagram finishing its render, an
 * image arriving, a font swapping. Those grow the document, and everything
 * below them moves without ever changing shape.
 */

import type { Editor } from "@tiptap/core";

/**
 * Re-run `schedule` whenever the manuscript may have moved under `observed`,
 * coalesced to one call per frame. Returns the teardown.
 */
export function watchManuscriptLayout(
  editor: Editor | null,
  observed: readonly (Element | null | undefined)[],
  schedule: () => void,
): () => void {
  let frame = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(schedule);
  };

  // Capture phase: the manuscript scrolls in a pane rather than the window, and
  // a surface has to travel with its block instead of hanging over whatever
  // paragraph took its place.
  window.addEventListener("scroll", run, true);
  window.addEventListener("resize", run);
  editor?.on("transaction", run);

  const observer = new ResizeObserver(run);
  const manuscript = editor && !editor.isDestroyed ? editor.view.dom : null;
  for (const element of [...observed, manuscript]) {
    if (element) observer.observe(element);
  }

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("scroll", run, true);
    window.removeEventListener("resize", run);
    editor?.off("transaction", run);
    observer.disconnect();
  };
}
