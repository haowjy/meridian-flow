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
