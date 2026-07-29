/**
 * EditorChromeHost — the one place editor chrome mounts.
 *
 * `EditorView` renders this once and never learns about a surface. Surfaces
 * arrive through `EDITOR_CHROME_SURFACES`, which is the seam; the alternative
 * — six lanes each patching `EditorView` — is six lanes editing one file.
 *
 * The host renders nothing of its own. Every surface here portals or floats,
 * so this element has no size and cannot push the manuscript around.
 */

import type { Editor } from "@tiptap/core";
import { Fragment } from "react";

import { EDITOR_CHROME_SURFACES } from "./chrome-surfaces";

export function EditorChromeHost({ editor }: { editor: Editor | null }) {
  if (!editor || editor.isDestroyed) return null;

  return (
    <>
      {EDITOR_CHROME_SURFACES.map((surface) => (
        <Fragment key={surface.id}>{surface.render({ editor })}</Fragment>
      ))}
    </>
  );
}
