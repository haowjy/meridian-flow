/**
 * What the formatting menu shows for the current selection: every item's lit
 * state, and the reason it cannot apply (law 5, law 6).
 *
 * Derived, never stored, and derived from the toolbar's command layer rather
 * than from a second reading of the document — the menu and the toolbar carry
 * the same verbs, so they must refuse the same targets for the same reasons.
 * The clipboard rows are not here: they are the block two claimed menus share,
 * and they live with it in [`clipboard-menu.tsx`](./clipboard-menu.tsx).
 */

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

/** The three verbs of the clipboard block (`clipboard-menu.tsx`). */
export type FormattingClipboardId = "cut" | "copy" | "paste";
export type FormattingItemState = {
  active: boolean;
  blockedBy: FormattingBlockedReason | null;
};

export type FormattingMenuModel = {
  marks: Record<FormattingMarkId, FormattingItemState>;
  turnInto: Record<BlockTypeId, FormattingItemState>;
  /**
   * Set when every block type refuses for one reason, which is the ordinary
   * case: the submenu then greys as a whole and never opens onto eight dead
   * rows. Null means the list is worth opening.
   */
  turnIntoBlockedBy: FormattingBlockedReason | null;
  link: FormattingItemState;
  /**
   * The caret is inside a table, so the menu carries the table's own lists
   * too (human ruling, 2026-07-29). A cell's text is prose either way (§5.4);
   * what changes is that a right-click in a cell is now the writer's way to
   * the table without hunting for a grip.
   */
  inTable: boolean;
};

/** The mark each row of the quick marks row toggles. */
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
  // The menu only opens on a writable document (see `formatting-triggers`),
  // but a document can turn read-only while it is open — a schema fence, a
  // lost lease — and every item must say so rather than silently no-op.
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

/** One reason shared by every item, or null when they disagree. */
function sharedBlocker(states: readonly FormattingItemState[]): FormattingBlockedReason | null {
  const first = states[0]?.blockedBy ?? null;
  if (!first) return null;
  return states.every((state) => state.blockedBy === first) ? first : null;
}
