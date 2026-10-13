/**
 * Takes the writer's place out of the review editor on screen in the commit
 * that removes it (a new draft generation, or the live editor taking over),
 * while its DOM and layout still exist. `getSnapshotBeforeUpdate` is the one
 * lifecycle that runs before React touches that DOM; the writer's focus is
 * remembered from the press that preceded it, since the pressed control has
 * taken it by then.
 */
import type { Editor } from "@tiptap/core";
import { Component, useCallback, useEffect, useRef } from "react";
import { captureReviewPlace } from "@/core/editor/review-place";

type Props = {
  /** The surface being shown; a review surface changing is its editor leaving. */
  surface: string;
  /** The review editor on screen, if one is. */
  editor: Editor | null;
  draftKey: string | null;
  focusOwned: () => boolean;
};

export class ReviewPlaceCapture extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Readonly<Props>) {
    if (
      previous.draftKey &&
      previous.editor &&
      previous.surface.startsWith("review:") &&
      previous.surface !== this.props.surface
    )
      captureReviewPlace(previous.draftKey, previous.editor, previous.focusOwned());
    return null;
  }
  componentDidUpdate() {}
  render() {
    return null;
  }
}

const PRESS_MEMORY_MS = 10_000;

/** Whether `editor` has the writer's focus, or had it when they last pressed a key or button. */
export function useEditorFocusOwned(editor: Editor | null): () => boolean {
  const press = useRef({ owned: false, at: 0 });
  useEffect(() => {
    if (!editor) return;
    const note = () => {
      press.current = {
        owned: !editor.isDestroyed && editor.view.hasFocus(),
        at: performance.now(),
      };
    };
    document.addEventListener("pointerdown", note, true);
    document.addEventListener("keydown", note, true);
    return () => {
      document.removeEventListener("pointerdown", note, true);
      document.removeEventListener("keydown", note, true);
    };
  }, [editor]);
  return useCallback(
    () =>
      editor !== null &&
      !editor.isDestroyed &&
      (editor.view.hasFocus() ||
        (press.current.owned && performance.now() - press.current.at < PRESS_MEMORY_MS)),
    [editor],
  );
}
