import { t } from "@lingui/core/macro";

import { shortcutLabel } from "../../chrome/shortcut-label";
import { type BlockedSubject, blockedReasonMessage, type ToolbarBlockedReason } from "../toolbar";
import type { FormattingClipboardId, FormattingMarkId } from "./formatting-menu-items";

export type FormattingBlockedReason =
  | ToolbarBlockedReason
  | "clipboard-read-blocked"
  | "clipboard-write-blocked";

export function formattingMarkLabel(mark: FormattingMarkId): string {
  switch (mark) {
    case "bold":
      return t`Bold`;
    case "italic":
      return t`Italic`;
    case "strike":
      return t`Strikethrough`;
    case "code":
      return t`Inline code`;
  }
}

export function turnIntoLabel(): string {
  return t`Turn into`;
}

export function addLinkLabel(): string {
  return t`Add link`;
}

export function clipboardLabel(id: FormattingClipboardId): string {
  switch (id) {
    case "cut":
      return t`Cut`;
    case "copy":
      return t`Copy`;
    case "paste":
      return t`Paste`;
  }
}

export function clipboardShortcut(id: FormattingClipboardId): string {
  switch (id) {
    case "cut":
      return shortcutLabel("Mod+X");
    case "copy":
      return shortcutLabel("Mod+C");
    case "paste":
      return shortcutLabel("Mod+V");
  }
}

export function formattingBlockedMessage(
  subject: BlockedSubject,
  reason: FormattingBlockedReason | null,
): string | null {
  if (reason === "clipboard-read-blocked" || reason === "clipboard-write-blocked")
    return t`Clipboard unavailable`;
  return blockedReasonMessage(subject, reason);
}
