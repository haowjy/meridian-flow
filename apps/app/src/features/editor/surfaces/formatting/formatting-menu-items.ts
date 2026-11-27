import type { Editor } from "@tiptap/core";

import { resolveChromeContext } from "@/core/editor/chrome";

import {
  BLOCK_TYPE_IDS,
  type BlockTypeId,
  blockedFirst,
  blockTypeStates,
  type ToolbarMarkName,
  textMarkState,
} from "../toolbar";
import type { FormattingBlockedReason } from "./formatting-copy";

export type FormattingMarkId = "bold" | "italic" | "strike" | "code";

export type FormattingClipboardId = "cut" | "copy" | "paste";
export type FormattingItemState = {
  active: boolean;
  blockedBy: FormattingBlockedReason | null;
};

export type FormattingMenuModel = {
  marks: Record<FormattingMarkId, FormattingItemState>;
  turnInto: Record<BlockTypeId, FormattingItemState>;
  turnIntoBlockedBy: FormattingBlockedReason | null;
  link: FormattingItemState;
  inTable: boolean;
};

export const FORMATTING_MARKS: Record<FormattingMarkId, ToolbarMarkName> = {
  bold: "strong",
  italic: "em",
  strike: "strike",
  code: "code",
};

export const FORMATTING_CLIPBOARD_IDS: readonly FormattingClipboardId[] = ["cut", "copy", "paste"];

export const FORMATTING_MARK_IDS: readonly FormattingMarkId[] = [
  "bold",
  "italic",
  "strike",
  "code",
];

export function formattingMenuModel(editor: Editor): FormattingMenuModel {
  const readOnly: FormattingBlockedReason | null = editor.isEditable ? null : "document-read-only";

  const turnInto = blockTypeStates(editor);
  const turnIntoStates = Object.fromEntries(
    BLOCK_TYPE_IDS.map((id) => [id, blockedFirst(readOnly, turnInto[id])]),
  ) as Record<BlockTypeId, FormattingItemState>;

  return {
    marks: Object.fromEntries(
      FORMATTING_MARK_IDS.map((id) => [
        id,
        blockedFirst(readOnly, textMarkState(editor, FORMATTING_MARKS[id])),
      ]),
    ) as Record<FormattingMarkId, FormattingItemState>,
    turnInto: turnIntoStates,
    turnIntoBlockedBy: sharedBlocker(Object.values(turnIntoStates)),
    link: blockedFirst(readOnly, textMarkState(editor, "link")),
    // The kernel's own resolver, not a second reading: a whole selected table
    // is a `CellSelection` and only that resolver reads both spellings.
    inTable: resolveChromeContext(editor.state).chain.includes("table"),
  };
}

function sharedBlocker(states: readonly FormattingItemState[]): FormattingBlockedReason | null {
  const first = states[0]?.blockedBy ?? null;
  if (!first) return null;
  return states.every((state) => state.blockedBy === first) ? first : null;
}
