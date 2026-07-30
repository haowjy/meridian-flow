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
  /**
   * Where focus goes when this surface closes and nothing took its place. The
   * default hands the caret back to the prose, which is right for a surface the
   * writer summoned at the caret.
   *
   * A lane supplies its own when its door is a focusable element INSIDE the
   * manuscript — a peer mark's span, reached by Tab — because a writer who
   * arrived by keyboard continues from the thing they were on, not from the
   * caret. It runs under the same two guards, which is the point of routing it
   * through here rather than racing this handler from a lane's own timer.
   */
  returnFocus?: () => void;
  /**
   * Keys this surface answers while it is open, in ProseMirror's spelling
   * (`"Mod-Enter"`). A binding returns true when it took the key.
   *
   * They belong to the layer rather than to the content inside it, because the
   * content is what comes and goes: a dialog's Ctrl+Enter has to open the pane
   * that is closed, and a pane cannot register the key that summons it. Declare
   * them inline — the handlers are read live, and only a change to the SET of
   * keys re-registers.
   */
  keys?: Readonly<Record<string, KeymapBinding>>;
};

export function useChromeLayer(
  editor: Editor | null,
  { id, open, close, dismissal = "kernel", returnFocus, keys }: UseChromeLayerOptions,
): ChromeLayerBinding {
  const chrome = useEditorChrome(editor);
  const parentId = useContext(ChromeLayerContext);
  // Known during render, so `scope` can hand it to children before the effect
  // that registers it has run.
  const layerId = `${id}#${useId()}`;

  const closeRef = useRef(close);
  closeRef.current = close;
  // Read live for the same reason as `close`: Radix calls this during teardown,
  // when the surface that owns the answer may already have rendered away.
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  // The kernel's own token for this layer, held in state rather than a ref
  // because the keys registration below is keyed on it: every re-registration
  // of the layer mints a new one, and keys naming the token of a layer that has
  // been replaced would be keys nothing can reach.
  const [layer, setLayer] = useState<ChromeLayer | null>(null);

  useEffect(() => {
    if (!chrome || !open) return;
    const handle = chrome.openLayer({
      id: layerId,
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
  // The registration is keyed on the key NAMES, not on the record: a lane
  // declares `keys` inline, so the object is new every render and re-registering
  // on it would churn the kernel's revision — and rebuild every merged keymap —
  // once per keystroke the surface handles. The handlers come from the ref, so
  // what runs is always the current render's.
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
    // Separate from the layer's own registration, because the two change on
    // different beats: a lane's key SET can change while the surface stays open
    // (a lightbox over an image has no source pane to toggle), and reopening
    // the layer for that would spend a step of the walk home and take every
    // layer inside it down.
    return chrome.registerKeymap({ id: layerId, scope: "layer", layer, reach: "chrome", bindings });
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
      if (!topmost || topmost.id === layerId) return;
      event.preventDefault();
      chrome?.closeTopLayer();
    },
    [chrome, layerId],
  );

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (!editor || editor.isDestroyed) return;
      // A layer being dismissed may not have released yet, so "another
      // surface" means any layer that is not this one.
      const successor = chrome?.layers.some((layer) => layer.id !== layerId);
      if (successor) return;
      // A modal surface that is not a chrome layer leaves no successor to
      // find, and still hides the manuscript behind it.
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
