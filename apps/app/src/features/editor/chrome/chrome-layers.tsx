/**
 * Putting an open surface in the Esc chain, and telling the chain where it
 * sits.
 *
 * Depth is the hard part. React mounts child effects before parent effects, so
 * a dialog that opens with its source pane already open registers the pane
 * first — and the design mandates exactly that (a new empty diagram opens with
 * its starter source showing). A chain that read registrations as a stack
 * would call the dialog topmost and close both on one Escape. So a layer says
 * who it is inside, through context, and the kernel orders by nesting rather
 * than by arrival.
 *
 * A surface that can contain another layer therefore has to wrap what it
 * renders in `layer.scope(...)`. The three wrappers in this directory already
 * do; a lane that hand-rolls a portal owes the same call.
 */

import type { Editor } from "@tiptap/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";

import type { ChromeLayerDismissal } from "@/core/editor/chrome";

import { useEditorChrome } from "./useEditorChrome";

const ChromeLayerContext = createContext<string | null>(null);

export type ChromeLayerBinding = {
  /** This layer's id in the chain. */
  id: string;
  /**
   * Give this to the Radix content's `onEscapeKeyDown`. It is the whole
   * subordination mechanism: Radix keeps owning its own dismissal, and defers
   * whenever the kernel knows something deeper is open.
   */
  onEscapeKeyDown: (event: { preventDefault: () => void; defaultPrevented?: boolean }) => void;
  /**
   * Give this to the Radix content's `onCloseAutoFocus`. Radix restores focus
   * to the trigger, which is right for a page and wrong for a manuscript: the
   * writer never left the sentence, so the next Space must be a space.
   *
   * Unless another surface is still open. A menu item that opens a form leaves
   * exactly that behind, and handing the caret back then pulls focus out of a
   * surface on the frame it appeared — which Radix reads as an outside
   * interaction and dismisses. So a close returns the caret only when it was
   * the last thing on screen.
   */
  onCloseAutoFocus: (event: Event) => void;
  /** Wrap whatever this surface renders, so a layer inside it knows its parent. */
  scope: (children: ReactNode) => ReactNode;
};

export type UseChromeLayerOptions = {
  /** Names the surface; the hook makes it unique per mounted instance. */
  id: string;
  open: boolean;
  close: () => void;
  /**
   * `"self"` for a surface with its own Escape listener — every Radix layer.
   * The default is `"kernel"`, because a layer with no listener of its own
   * would otherwise survive every Escape pressed outside the editor.
   */
  dismissal?: ChromeLayerDismissal;
};

export function useChromeLayer(
  editor: Editor | null,
  { id, open, close, dismissal = "kernel" }: UseChromeLayerOptions,
): ChromeLayerBinding {
  const chrome = useEditorChrome(editor);
  const parentId = useContext(ChromeLayerContext);
  // Known during render, so `scope` can hand it to children before the effect
  // that registers it has run.
  const layerId = `${id}#${useId()}`;

  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!chrome || !open) return;
    const handle = chrome.openLayer({
      id: layerId,
      parentId,
      dismissal,
      close: () => closeRef.current(),
    });
    return () => handle.release();
  }, [chrome, layerId, parentId, dismissal, open]);

  const onEscapeKeyDown = useCallback(
    (event: { preventDefault: () => void; defaultPrevented?: boolean }) => {
      // The kernel's backstop already took this one; keep Radix out of it or
      // the key closes two surfaces.
      if (event.defaultPrevented) {
        event.preventDefault();
        return;
      }
      const topmost = chrome?.layers[chrome.layers.length - 1];
      if (!topmost || topmost.id === layerId) return;
      event.preventDefault();
      chrome?.closeTopLayer();
    },
    [chrome, layerId],
  );

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      // A layer being dismissed may not have released yet, so "another
      // surface" means any layer that is not this one.
      const successor = chrome?.layers.some((layer) => layer.id !== layerId);
      if (successor) return;
      if (editor && !editor.isDestroyed) editor.commands.focus();
    },
    [chrome, editor, layerId],
  );

  const scope = useCallback(
    (children: ReactNode) => (
      <ChromeLayerContext.Provider value={layerId}>{children}</ChromeLayerContext.Provider>
    ),
    [layerId],
  );

  return { id: layerId, onCloseAutoFocus, onEscapeKeyDown, scope };
}
