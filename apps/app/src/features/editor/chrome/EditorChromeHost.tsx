import type { Editor } from "@tiptap/core";
import { Fragment } from "react";

import { EDITOR_CHROME_SURFACES } from "./chrome-surfaces";

export function EditorChromeHost({
  editor,
  active = true,
}: {
  editor: Editor | null;
  /** False for an editor hidden behind the visible one. */
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
