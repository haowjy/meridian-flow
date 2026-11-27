/**
 * The doors to the formatting menu, wired to one open call.
 *
 * A right-click reaches the kernel's claim ladder and comes back here at one of
 * two rungs — `text-selection` for a sweep the pointer is inside, `caret` for
 * everything else in the prose — and the Menu key and Shift+F10 are a keymap
 * contribution. Touch arrives through the first door, not a third one: a long
 * press is a `contextmenu` wherever the browser gives the page one, and routing
 * it through the ladder is what lets a link or a diagram under the finger
 * outrank these rungs. A private pointer timer could not ask that question and
 * would open over the browser's own callout.
 *
 * Every registration rides an effect rather than TipTap's `create` event, which
 * arrives a macrotask late: long enough for the writer's first Shift+F10 to
 * miss it.
 */

import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { useEffect, useRef } from "react";

import { useEditorChrome } from "../../chrome";
import {
  claimsCaretFormattingMenu,
  claimsFormattingMenu,
  type FormattingMenuPoint,
  formattingMenuOpensFor,
  formattingOwnsContext,
  placeCaretForMenu,
  selectionAnchorPoint,
} from "./formatting-triggers";

export function useFormattingMenuDoors(
  editor: Editor,
  open: (point: FormattingMenuPoint) => void,
): void {
  const chrome = useEditorChrome(editor);
  // The claim and the keymap register once and live as long as the editor;
  // reading the current handler through a ref keeps a re-render from churning
  // the kernel's registries.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!chrome) return;

    return chrome.registerContextClaim({
      id: "text-selection",
      claim: (target) => {
        if (!claimsFormattingMenu(editor, target)) return false;
        openRef.current({ x: target.event.clientX, y: target.event.clientY });
        return true;
      },
    });
  }, [chrome, editor]);

  // The ladder's floor: every right-click in the prose that no more specific
  // rung wanted. The caret moves to the pointer FIRST, synchronously, because
  // the model this menu renders is read from the selection — a menu opened
  // over the third paragraph must not offer to convert the first.
  useEffect(() => {
    if (!chrome) return;

    return chrome.registerContextClaim({
      id: "caret",
      claim: (target) => {
        if (target.docPos === null) return false;
        if (!claimsCaretFormattingMenu(editor, target)) return false;
        placeCaretForMenu(editor, target.docPos);
        openRef.current({ x: target.event.clientX, y: target.event.clientY });
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
      // first, as it should. `appliesTo` is the other half of the split matrix
      // — the keyboard twin must fall silent wherever the right-click declines.
      scope: "document",
      appliesTo: formattingOwnsContext,
      bindings: {
        ContextMenu: (_state, _dispatch, view) => (view ? openFromKeyboard(view) : false),
        "Shift-F10": (_state, _dispatch, view) => (view ? openFromKeyboard(view) : false),
      },
    });
  }, [chrome, editor]);
}
