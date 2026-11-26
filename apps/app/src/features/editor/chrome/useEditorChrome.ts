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

export function useChromeContext(editor: Editor | null): ChromeContext {
  const chrome = useEditorChrome(editor);
  return useSyncExternalStore(
    chrome ? chrome.subscribe : NO_SUBSCRIPTION,
    () => chrome?.context ?? DOCUMENT_CHROME_CONTEXT,
    () => DOCUMENT_CHROME_CONTEXT,
  );
}

export function useChromeSuppressed(editor: Editor | null): boolean {
  const chrome = useEditorChrome(editor);
  return useSyncExternalStore(
    chrome ? chrome.subscribe : NO_SUBSCRIPTION,
    () => chrome?.suppressed ?? false,
    () => false,
  );
}

export function useChromeCoarsePointer(editor: Editor | null): boolean {
  const chrome = useEditorChrome(editor);
  return useSyncExternalStore(
    chrome ? chrome.subscribe : NO_SUBSCRIPTION,
    () => chrome?.coarsePointer ?? false,
    () => false,
  );
}

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
