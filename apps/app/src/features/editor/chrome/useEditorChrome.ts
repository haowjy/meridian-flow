/**
 * React's view of the chrome kernel.
 *
 * The kernel is a plain store, so these hooks are the whole adapter: read the
 * resolved context, read suppression, and register an open surface as a layer.
 * A surface that reaches into `getEditorChrome` directly and holds its own
 * `useState` copy will drift; read through here.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

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
 * Re-render on every editor change.
 *
 * The bluntest possible subscription, and the right one for chrome that reads
 * the document directly — a toolbar's lit states, a chip cluster's language
 * label. Surfaces that only need the resolved context or suppression should
 * read those stores instead: they notify when their answer changes, not when
 * the document does.
 */
export function useEditorRevision(editor: Editor | null): void {
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setRevision((revision) => revision + 1);
    editor.on("selectionUpdate", bump);
    editor.on("transaction", bump);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("transaction", bump);
    };
  }, [editor]);
}
