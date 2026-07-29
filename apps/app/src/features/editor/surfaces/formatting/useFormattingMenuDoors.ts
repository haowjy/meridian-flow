/**
 * The three doors to the formatting menu, wired to one open call.
 *
 * Right-click reaches the kernel's claim ladder and comes back here; the Menu
 * key and Shift+F10 are a keymap contribution; a long press on touch is a
 * pointer timer. The kernel routes `contextmenu` and nothing else, so the last
 * two are this lane's to own — and all three end in the same `open(point)`, so
 * the surface has one entry point rather than three states to keep in sync.
 *
 * Both registrations ride effects rather than TipTap's `create` event, which
 * arrives a macrotask late: long enough for the writer's first Shift+F10 to
 * miss it.
 */

import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { useEffect, useRef } from "react";

import { useEditorChrome } from "../../chrome";
import {
  claimsFormattingMenu,
  type FormattingMenuPoint,
  formattingMenuOpensFor,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  pointInsideSelection,
  selectionAnchorPoint,
} from "./formatting-triggers";

/**
 * Android answers a long press with a `contextmenu` event of its own, so the
 * timer and the claim both fire for one gesture. Whichever lands first owns
 * it; this is how long the other one stands down.
 */
const LONG_PRESS_SETTLE_MS = 700;

export function useFormattingMenuDoors(
  editor: Editor,
  {
    isOpen,
    open,
  }: {
    isOpen: () => boolean;
    open: (point: FormattingMenuPoint) => void;
  },
): void {
  const chrome = useEditorChrome(editor);
  // The claim and the keymap register once and live as long as the editor;
  // reading the current handlers through refs keeps a re-render from churning
  // the kernel's registries.
  const openRef = useRef(open);
  openRef.current = open;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const longPressedAt = useRef(0);

  useEffect(() => {
    if (!chrome) return;

    return chrome.registerContextClaim({
      id: "text-selection",
      claim: (target) => {
        if (!claimsFormattingMenu(editor, target)) return false;
        // A long press that already opened the menu still claims the event —
        // the native menu must not arrive over the one the writer is looking
        // at — but it does not re-open, which would remount the menu at a
        // point one pixel away from where it stands.
        if (Date.now() - longPressedAt.current > LONG_PRESS_SETTLE_MS) {
          openRef.current({ x: target.event.clientX, y: target.event.clientY });
        }
        return true;
      },
    });
  }, [chrome, editor]);

  useEffect(() => {
    if (!chrome) return;

    const openFromKeyboard = (view: EditorView): boolean => {
      if (!formattingMenuOpensFor(editor)) return false;
      const point = selectionAnchorPoint(view);
      if (!point) return false;
      openRef.current(point);
      return true;
    };

    return chrome.registerKeymap({
      id: "formatting-menu",
      // The menu formats whatever the selection covers, so it belongs to the
      // document: an open surface or a selected object answers these keys
      // first, as it should.
      scope: "document",
      bindings: {
        ContextMenu: (_state, _dispatch, view) => (view ? openFromKeyboard(view) : false),
        "Shift-F10": (_state, _dispatch, view) => (view ? openFromKeyboard(view) : false),
      },
    });
  }, [chrome, editor]);

  useEffect(() => {
    const dom = editor.view.dom;
    let timer: number | undefined;
    let origin: FormattingMenuPoint | null = null;

    const cancel = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      origin = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      cancel();
      const point = { x: event.clientX, y: event.clientY };
      origin = point;
      timer = window.setTimeout(() => {
        cancel();
        if (editor.isDestroyed || isOpenRef.current()) return;
        // A press that turned into a drag or a sweep is a gesture, not a
        // question; the kernel is the one that knows.
        if (chrome?.suppressed) return;
        if (!formattingMenuOpensFor(editor)) return;
        if (!pointInsideSelection(editor.view, point)) return;
        longPressedAt.current = Date.now();
        openRef.current(point);
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!origin) return;
      const travelled = Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
      if (travelled >= LONG_PRESS_SLOP_PX) cancel();
    };

    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", cancel);
    dom.addEventListener("pointercancel", cancel);
    // The manuscript scrolls in a pane, and a scroll under a resting finger is
    // the commonest way a long press stops being one.
    window.addEventListener("scroll", cancel, true);

    return () => {
      cancel();
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", cancel);
      dom.removeEventListener("pointercancel", cancel);
      window.removeEventListener("scroll", cancel, true);
    };
  }, [chrome, editor]);
}
