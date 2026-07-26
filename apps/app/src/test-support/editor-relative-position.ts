/** Relative-position construction for editor integration tests. */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import {
  relativePositionForIndex,
  relativePositionRuntimeFromState,
} from "../core/editor/relative-position-runtime";

export function relativePositionForEditorIndex(
  editor: Editor,
  index: number,
): Y.RelativePosition | null {
  const runtime = relativePositionRuntimeFromState(editor.state);
  return runtime ? relativePositionForIndex(runtime, index) : null;
}
