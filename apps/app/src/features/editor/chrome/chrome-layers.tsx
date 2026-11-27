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
 *
 * A layer is also where its keys belong. `keys` registers them with the kernel
 * for as long as the surface is open, at `layer` scope, with the reach that
 * survives focus sitting inside portalled content, and naming the layer that
 * owns them — so a dialog's shortcut is in the kernel's bindings, runs its
 * scope ladder, loses to the pane the dialog opened, and collides through the
 * same validation as every other lane's. A `document` listener in a surface has
 * none of that.
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
  useState,
} from "react";

import type { ChromeLayer, ChromeLayerDismissal, KeymapBinding } from "@/core/editor/chrome";

import { useEditorChrome } from "./useEditorChrome";

const ChromeLayerContext = createContext<string | null>(null);

export type ChromeLayerBinding = {
  id: string;
  onEscapeKeyDown: (event: { preventDefault: () => void; defaultPrevented?: boolean }) => void;
  /**
   * Give this to the Radix content's `onCloseAutoFocus`. Radix restores focus
   * to the trigger, which is right for a page and wrong for a manuscript: the
   * writer never left the sentence, so the next Space must be a space.
   *
   * Unless the prose cannot take it. Two ways that happens: another surface is
   * still open — a menu item that opened a form leaves exactly that behind, and
   * handing the caret back pulls focus out of a surface on the frame it
   * appeared, which Radix reads as an outside interaction and dismisses — or
   * the page itself is behind a modal scrim, `aria-hidden` and untouchable, in
   * which case the dialog drags focus back asynchronously and lands it on
   * whatever happens to be first inside. Either way the caret stays where the
   * writer left it.
   */
  onCloseAutoFocus: (event: Event) => void;
  scope: (children: ReactNode) => ReactNode;
};

export type UseChromeLayerOptions = {
  id: string;
  open: boolean;
  close: () => void;
  dismissal?: ChromeLayerDismissal;
  returnFocus?: () => void;
  keys?: Readonly<Record<string, KeymapBinding>>;
};

export function useChromeLayer(
  editor: Editor | null,
  { id, open, close, dismissal = "kernel", returnFocus, keys }: UseChromeLayerOptions,
): ChromeLayerBinding {
  const chrome = useEditorChrome(editor);
  const parentId = useContext(ChromeLayerContext);
  const layerId = `${id}#${useId()}`;

  const closeRef = useRef(close);
  closeRef.current = close;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  const [layer, setLayer] = useState<ChromeLayer | null>(null);

  useEffect(() => {
    if (!chrome || !open) return;
    const handle = chrome.openLayer({
      id: layerId,
      ownerId: id,
      parentId,
      dismissal,
      close: () => closeRef.current(),
    });
    setLayer(handle.layer);
    return () => {
      handle.release();
      setLayer(null);
    };
  }, [chrome, layerId, parentId, dismissal, open]);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const keyNames = keys ? Object.keys(keys).sort().join(" ") : "";

  useEffect(() => {
    if (!chrome || !layer || keyNames === "") return;
    const bindings = Object.fromEntries(
      keyNames
        .split(" ")
        .map((key): [string, KeymapBinding] => [
          key,
          (state, dispatch, view) => keysRef.current?.[key]?.(state, dispatch, view) ?? false,
        ]),
    );
    return chrome.registerKeymap({ id: layerId, scope: "layer", layer, route: "chrome", bindings });
  }, [chrome, layer, layerId, keyNames]);

  const onEscapeKeyDown = useCallback(
    (event: { preventDefault: () => void; defaultPrevented?: boolean }) => {
      // The kernel's backstop already took this one; keep Radix out of it or
      // the key closes two surfaces.
      if (event.defaultPrevented) {
        event.preventDefault();
        return;
      }
      const topmost = chrome?.layers[chrome.layers.length - 1];
      if (!topmost) return;
      if (topmost.id === layerId) {
        if (!chrome?.retreatTopLayer()) return;
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!chrome?.retreatTopLayer()) chrome?.closeTopLayer();
    },
    [chrome, layerId],
  );

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (!editor || editor.isDestroyed) return;
      // Radix calls this a task after the close, so any layer open now, this
      // one included, opened since: reopened by the same click, it keeps focus.
      if (chrome?.layers.length) return;
      if (editor.view.dom.closest('[aria-hidden="true"], [inert]')) return;
      const lane = returnFocusRef.current;
      if (lane) {
        lane();
        return;
      }
      editor.commands.focus();
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
