/**
 * React's view of the chrome kernel.
 *
 * The kernel is a plain store, so these hooks are the whole adapter: read the
 * resolved context, read suppression, and register an open surface as a layer.
 * A surface that reaches into `getEditorChrome` directly and holds its own
 * `useState` copy will drift; read through here.
 */

import type { Editor } from "@tiptap/core";
import { useMemo, useSyncExternalStore } from "react";

import {
  type ChromeContext,
  DOCUMENT_CHROME_CONTEXT,
  type EditorChrome,
  getEditorChrome,
} from "@/core/editor/chrome";

const NO_SUBSCRIPTION = () => () => {};

export function useEditorChrome(editor: Editor | null): EditorChrome | null {
  return useMemo(() => getEditorChrome(editor), [editor]);
}

/**
 * The deepest context owning chrome right now (law 4). A persistent consumer —
 * the toolbar — reads this to grey; a transient one reads it to decide whether
 * it is the owner at all.
 */
export function useChromeContext(editor: Editor | null): ChromeContext {
  const chrome = useEditorChrome(editor);
  return useSyncExternalStore(
    chrome ? chrome.subscribe : NO_SUBSCRIPTION,
    () => chrome?.context ?? DOCUMENT_CHROME_CONTEXT,
    () => DOCUMENT_CHROME_CONTEXT,
  );
}

/**
 * True while the writer is dragging or sweeping. Every surface that can be on
 * screen reads it and stands down; nothing tries to be clever about which
 * gesture it was.
 */
export function useChromeSuppressed(editor: Editor | null): boolean {
  const chrome = useEditorChrome(editor);
  return useSyncExternalStore(
    chrome ? chrome.subscribe : NO_SUBSCRIPTION,
    () => chrome?.suppressed ?? false,
    () => false,
  );
}

/**
 * True when the writer's last input device was a finger or a pen.
 *
 * A tap has no approach to settle, so the surfaces that can follow the
 * selection instead read this rather than sniffing the device themselves —
 * one answer, from the one listener that sees every pointer in the editor.
 */
export function useChromeCoarsePointer(editor: Editor | null): boolean {
  const chrome = useEditorChrome(editor);
  return useSyncExternalStore(
    chrome ? chrome.subscribe : NO_SUBSCRIPTION,
    () => chrome?.coarsePointer ?? false,
    () => false,
  );
}

/**
 * Re-render on every editor change, and answer which change this is.
 *
 * The bluntest possible subscription, and the right one for chrome that reads
 * the document directly — a toolbar's lit states, a chip cluster's language
 * label. Surfaces that only need the resolved context or suppression should
 * read those stores instead: they notify when their answer changes, not when
 * the document does.
 *
 * The revision is for an effect that has to re-read the document rather than
 * only re-render with it: an effect depending on a value the document supplies
 * cannot see a change the document made underneath that value.
 */
export function useEditorRevision(editor: Editor | null): number {
  const store = useMemo(() => editorRevisionStore(editor), [editor]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, ZERO_REVISION);
}

type EditorRevisionStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
};

const NO_REVISIONS: EditorRevisionStore = {
  subscribe: () => () => {},
  getSnapshot: () => 0,
};

const ZERO_REVISION = () => 0;

/**
 * One revision store per editor, counting from the first read of it.
 *
 * The count has to live outside React. A hook that kept it in `useState` and
 * subscribed in an effect could not see a transaction that landed in between —
 * layout effects run before passive ones, so a surface that writes while it
 * measures moves the document in exactly that window — and the consumer would
 * then render the state before it with nothing to tell it otherwise.
 *
 * Keyed on the editor and held weakly: two surfaces reading the same editor
 * share one counter and one listener, and the store goes when the editor does.
 * The listener is attached for the editor's life rather than per subscriber,
 * because the missed transaction is the whole point — a store that only counted
 * while React was listening would have the same blind spot. `destroy` takes it
 * off with every other listener the editor holds.
 *
 * One subscription, not two: a selection change IS a transaction, so listening
 * for both rendered every caret move twice.
 */
const EDITOR_REVISIONS = new WeakMap<Editor, EditorRevisionStore>();

function editorRevisionStore(editor: Editor | null): EditorRevisionStore {
  if (!editor || editor.isDestroyed) return NO_REVISIONS;

  const existing = EDITOR_REVISIONS.get(editor);
  if (existing) return existing;

  let revision = 0;
  const listeners = new Set<() => void>();
  editor.on("transaction", () => {
    revision += 1;
    for (const listener of listeners) listener();
  });

  const store: EditorRevisionStore = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => revision,
  };
  EDITOR_REVISIONS.set(editor, store);
  return store;
}
