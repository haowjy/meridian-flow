/**
 * React's view of the chrome kernel.
 *
 * The kernel is a plain store, so these hooks are the whole adapter: read the
 * resolved context, read suppression, and register an open surface as a layer.
 * A surface that reaches into `getEditorChrome` directly and holds its own
 * `useState` copy will drift; read through here.
 */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

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

export type ChromeLayerBinding = {
  /**
   * Give this to the Radix content's `onEscapeKeyDown`. It is the whole
   * subordination mechanism: Radix keeps owning its own dismissal, and defers
   * only when the kernel knows something deeper is open.
   */
  onEscapeKeyDown: (event: { preventDefault: () => void }) => void;
  /**
   * Give this to the Radix content's `onCloseAutoFocus`. Radix restores focus
   * to the trigger, which is right for a page and wrong for a manuscript: the
   * writer never left the sentence, so the next Space must be a space.
   *
   * Unless another surface is still open. A menu item that opens a form leaves
   * exactly that behind, and returning the caret then would pull focus out of
   * a surface on the frame it appeared — so a close hands the caret back only
   * when it was the last thing on screen.
   */
  onCloseAutoFocus: (event: Event) => void;
};

/**
 * Put an open surface in the Esc chain and take it out again when it closes.
 *
 * The kernel calls `close` for the topmost layer; pointing it at the same
 * `onOpenChange(false)` Radix already uses keeps one dismissal path, so the
 * animation, the focus return, and the chain cannot disagree about what closed.
 *
 * Radix dismisses on Escape from a document listener, which is right until a
 * layer that is NOT a Radix layer opens inside one — a source pane inside the
 * diagram dialog. Radix cannot see that pane, so it would close the dialog and
 * take the pane with it, spending two steps of the walk home on one key. The
 * returned `onEscapeKeyDown` is how a surface says "not mine yet".
 */
export function useChromeLayer(
  editor: Editor | null,
  { id, open, close }: { id: string; open: boolean; close: () => void },
): ChromeLayerBinding {
  const chrome = useEditorChrome(editor);
  const closeRef = useRef(close);
  closeRef.current = close;
  const layerIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!chrome || !open) return;
    const handle = chrome.openLayer({ id, close: () => closeRef.current() });
    layerIdRef.current = handle.id;
    return () => {
      layerIdRef.current = null;
      handle.release();
    };
  }, [chrome, id, open]);

  const onEscapeKeyDown = useCallback(
    (event: { preventDefault: () => void }) => {
      const topmost = chrome?.layers[chrome.layers.length - 1];
      if (!topmost || topmost.id === layerIdRef.current) return;
      event.preventDefault();
      chrome?.closeTopLayer();
    },
    [chrome],
  );

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      const successor = chrome?.layers.some((layer) => layer.id !== layerIdRef.current);
      if (successor) return;
      if (editor && !editor.isDestroyed) editor.commands.focus();
    },
    [chrome, editor],
  );

  return { onEscapeKeyDown, onCloseAutoFocus };
}
