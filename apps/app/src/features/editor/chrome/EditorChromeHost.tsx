/**
 * EditorChromeHost — the one place editor chrome mounts.
 *
 * `EditorView` renders this once and never learns about a surface. Surfaces
 * arrive through `EDITOR_CHROME_SURFACES`, which is the seam; the alternative
 * — six lanes each patching `EditorView` — is six lanes editing one file.
 *
 * The host renders nothing of its own. Every surface here portals or floats,
 * so this element has no size and cannot push the manuscript around.
 *
 * It mounts for the ACTIVE editor only. The desktop context host keeps several
 * editors warm behind the visible one and hides them with `hidden`, which does
 * nothing to a menu, a dialog, or a suggestion list: those portal to the body
 * and would paint over the document the writer is actually reading, anchored
 * to a rect in a pane nobody can see.
 */

import type { Editor } from "@tiptap/core";
import { Fragment } from "react";

import { EDITOR_CHROME_SURFACES } from "./chrome-surfaces";

export function EditorChromeHost({
  editor,
  active = true,
}: {
  editor: Editor | null;
  /** False for an editor kept warm behind the visible one. */
  active?: boolean;
}) {
  if (!editor || editor.isDestroyed || !active) return null;

  return (
    <>
      {EDITOR_CHROME_SURFACES.map((surface) => (
        <Fragment key={surface.id}>{surface.render({ editor })}</Fragment>
      ))}
    </>
  );
}
