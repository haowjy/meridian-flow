import type { Editor } from "@tiptap/core";

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
