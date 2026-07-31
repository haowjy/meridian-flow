/**
 * Which peer mark the writer opened, and where they were standing when they
 * did.
 *
 * The press is the mark's own identity (`changeId`, whose anchor is a relative
 * position) plus the caret the writer left behind, held rather than numbered: a
 * popover stays open while the writer reads, and this document's peers are
 * writing the whole time. Nothing here remembers a span — the decoration
 * drawing a mark is rebuilt on every remote write.
 *
 * Headless and per-editor, like the link lane's store: the extension beside it
 * turns a click or an Enter into `open`, the surface reads it through
 * `useSyncExternalStore`, and the walk home closes it.
 */

import type { Editor } from "@tiptap/core";

import { type EditorAnchor, resolveAnchorIn } from "../anchors";

/** Which door the writer came through, because focus goes back the same way. */
export type PeerMarkActivation = "pointer" | "keyboard";

export type PeerMarkPress = {
  /** The mark's own identity, which survives the decoration being rebuilt. */
  changeId: string;
  activation: PeerMarkActivation;
  /** Where the writer's caret was when the mark was opened. */
  editorSelection: EditorAnchor;
};

export type PeerMarkPressStore = {
  readonly press: PeerMarkPress | null;
  subscribe: (listener: () => void) => () => void;
  open: (press: PeerMarkPress) => void;
  close: () => void;
};

export function createPeerMarkPressStore(): PeerMarkPressStore {
  const listeners = new Set<() => void>();
  let press: PeerMarkPress | null = null;

  const set = (next: PeerMarkPress | null) => {
    if (press === next) return;
    press = next;
    for (const listener of listeners) listener();
  };

  return {
    get press() {
      return press;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(next) {
      set(next);
    },
    close() {
      set(null);
    },
  };
}

/**
 * Put the writer back where they were. Null when the words they were standing
 * in are gone, in which case leaving the caret alone beats guessing.
 */
export function restorePeerMarkSelection(editor: Editor | null, held: EditorAnchor): void {
  if (!editor || editor.isDestroyed) return;
  const at = resolveAnchorIn(editor.state, held);
  if (at) editor.chain().setTextSelection(at).focus().run();
}
