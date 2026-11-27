import type { Editor } from "@tiptap/core";
import { ClipboardPaste, Copy, Scissors } from "lucide-react";
import { type ComponentType, useState } from "react";
import { EditorMenuItem } from "../../chrome";

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

const CLIPBOARD_DIRECTION: Record<FormattingClipboardId, keyof ClipboardAccess> = {
  cut: "write",
  copy: "write",
  paste: "read",
};

export function clipboardItemStates(
  editor: Editor,
  clipboard: ClipboardAccess,
): Record<FormattingClipboardId, FormattingItemState> {
  const readOnly: FormattingBlockedReason | null = editor.isEditable ? null : "document-read-only";
  const write: FormattingBlockedReason | null =
    clipboard.write === "available" ? null : "clipboard-write-blocked";
  const read: FormattingBlockedReason | null =
    clipboard.read === "available" ? null : "clipboard-read-blocked";

  return {
    cut: { active: false, blockedBy: readOnly ?? write },
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
  prepare?: () => void;
  closeMenu: () => void;
}) {
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
            note={clipboardShortcut(id)}
          >
            <Icon />
            {clipboardLabel(id)}
          </EditorMenuItem>
        );
      })}
    </>
  );
}
