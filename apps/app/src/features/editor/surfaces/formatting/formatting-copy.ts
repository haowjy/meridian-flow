/**
 * Writer-facing copy for the formatting menu: every item's label, and the
 * reasons an item greys.
 *
 * The reasons are the toolbar's — same codes, same wording, because a writer
 * who learned why Bold is grey on the toolbar should not have to learn it
 * again in the menu. Only one reason is the menu's own: no toolbar control
 * pastes, so no toolbar copy explains a browser that keeps the clipboard from
 * the page.
 */
import { t } from "@lingui/core/macro";

import {
  type BlockedSubject,
  type BlockTypeId,
  blockedReasonMessage,
  type ToolbarBlockedReason,
} from "../toolbar";
import type { FormattingClipboardId, FormattingMarkId } from "./formatting-menu-items";

/** The toolbar's reasons plus the one only a paste control can hit. */
export type FormattingBlockedReason = ToolbarBlockedReason | "clipboard-read-blocked";

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

export function blockTypeLabel(id: BlockTypeId): string {
  switch (id) {
    case "paragraph":
      return t`Paragraph`;
    case "heading1":
      return t`Heading 1`;
    case "heading2":
      return t`Heading 2`;
    case "heading3":
      return t`Heading 3`;
    case "bulletList":
      return t`Bulleted list`;
    case "orderedList":
      return t`Numbered list`;
    case "blockquote":
      return t`Quote`;
    case "codeBlock":
      return t`Code block`;
  }
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

/** The clipboard staples keep their shortcuts: the menu is not the fast path. */
export function clipboardShortcut(id: FormattingClipboardId): string {
  switch (id) {
    case "cut":
      return shortcutLabel("X");
    case "copy":
      return shortcutLabel("C");
    case "paste":
      return shortcutLabel("V");
  }
}

export function formattingBlockedMessage(
  subject: BlockedSubject,
  reason: FormattingBlockedReason | null,
): string | null {
  if (reason === "clipboard-read-blocked") {
    const shortcut = shortcutLabel("V");
    return t`This browser will not hand the clipboard to the page. Press ${shortcut} to paste.`;
  }
  return blockedReasonMessage(subject, reason);
}

function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * Mod is Cmd on macOS throughout (§4). Read from the browser rather than
 * configured: the shortcut is the OS's, not the document's.
 */
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
