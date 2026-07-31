/**
 * Cut, Copy, and Paste as menu rows: the block every claimed menu carries.
 *
 * Two menus reach for it — the formatting menu over a selection (§5.1) and the
 * link menu over a link (§5.5, mockup 06 state C) — and the writer must meet
 * one answer in both: the same wording, the same shortcut, and the same reason
 * when a browser withholds a direction. Three separate rows in two files would
 * be two answers within a week, so the state, the copy, and the greying live
 * here once and the menus mount them.
 *
 * What differs between the two is only WHERE the verbs act, and that is the
 * `prepare` prop: the formatting menu means the selection the writer swept,
 * and the link menu means the link they pointed at.
 */

import type { Editor } from "@tiptap/core";
import { ClipboardPaste, Copy, Scissors } from "lucide-react";
import { type ComponentType, useState } from "react";
import { EditorMenuItem, EditorMenuShortcut } from "../../chrome";

import { type ClipboardAccess, clipboardAccess } from "../../clipboard";
import {
  type ClipboardResult,
  copySelection,
  cutSelection,
  pasteIntoSelection,
} from "./clipboard-commands";
import {
  clipboardLabel,
  clipboardShortcut,
  type FormattingBlockedReason,
  formattingBlockedMessage,
} from "./formatting-copy";
import {
  FORMATTING_CLIPBOARD_IDS,
  type FormattingClipboardId,
  type FormattingItemState,
} from "./formatting-menu-items";

const CLIPBOARD_ICONS: Record<FormattingClipboardId, ComponentType<{ className?: string }>> = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
};

const CLIPBOARD_COMMANDS: Record<
  FormattingClipboardId,
  (editor: Editor) => Promise<ClipboardResult>
> = {
  cut: cutSelection,
  copy: copySelection,
  paste: pasteIntoSelection,
};

/** Which direction of the clipboard each verb needs. */
const CLIPBOARD_DIRECTION: Record<FormattingClipboardId, keyof ClipboardAccess> = {
  cut: "write",
  copy: "write",
  paste: "read",
};

/**
 * Whether each row can run, and why not (law 5). A browser can withhold either
 * direction, and the writer needs to hear which one and what to press instead.
 */
export function clipboardItemStates(
  editor: Editor,
  clipboard: ClipboardAccess,
): Record<FormattingClipboardId, FormattingItemState> {
  // A menu opens on a writable document, but a document can turn read-only
  // while it is open — a schema fence, a lost lease — and every item must say
  // so rather than silently no-op.
  const readOnly: FormattingBlockedReason | null = editor.isEditable ? null : "document-read-only";
  const write: FormattingBlockedReason | null =
    clipboard.write === "available" ? null : "clipboard-write-blocked";
  const read: FormattingBlockedReason | null =
    clipboard.read === "available" ? null : "clipboard-read-blocked";

  return {
    cut: { active: false, blockedBy: readOnly ?? write },
    // Copying is reading; a document nobody may change is still readable.
    copy: { active: false, blockedBy: write },
    paste: { active: false, blockedBy: readOnly ?? read },
  };
}

export function ClipboardMenuItems({
  editor,
  prepare,
  closeMenu,
}: {
  editor: Editor;
  /**
   * Put the selection where this menu means before the verb runs. The
   * formatting menu needs none: the writer's selection is already the subject.
   */
  prepare?: () => void;
  /**
   * Dismiss the menu these rows sit in. Required, because a verb that ran has to
   * take the menu with it and only the menu it was mounted in knows how it
   * closes.
   */
  closeMenu: () => void;
}) {
  // A browser that refused once will refuse again for as long as this menu is
  // open, so the row greys with its shortcut from the press it refused rather
  // than failing silently a second time (law 5). Capability answers what it can
  // before the writer presses; only a real refusal can answer the rest, and the
  // next open asks the browser again, because a permission can be granted.
  const [clipboard, setClipboard] = useState<ClipboardAccess>(clipboardAccess);
  const states = clipboardItemStates(editor, clipboard);

  return (
    <>
      {FORMATTING_CLIPBOARD_IDS.map((id) => {
        const Icon = CLIPBOARD_ICONS[id];

        return (
          <EditorMenuItem
            key={id}
            blockedReason={formattingBlockedMessage("document", states[id].blockedBy)}
            onSelect={(event) => {
              // The menu is the only thing on screen that can carry the answer,
              // so it stays open until the verb settles and closes only on one
              // that ran. Radix closes on select, which would land the greying
              // on a row that had already gone and report the refusal by
              // disappearing — law 5's silent rejection, in the shape a writer
              // reads as success.
              event.preventDefault();
              prepare?.();
              void CLIPBOARD_COMMANDS[id](editor).then((result) => {
                if (result !== "denied" && result !== "unavailable") {
                  closeMenu();
                  return;
                }
                const direction = CLIPBOARD_DIRECTION[id];
                setClipboard((current) => ({ ...current, [direction]: "unavailable" }));
              });
            }}
          >
            <Icon />
            {clipboardLabel(id)}
            <EditorMenuShortcut>{clipboardShortcut(id)}</EditorMenuShortcut>
          </EditorMenuItem>
        );
      })}
    </>
  );
}
