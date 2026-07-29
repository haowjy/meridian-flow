/**
 * Turn into: the block menu's whole-block conversions (§5.8, §5.1).
 *
 * The fence is not re-derived here. `blockTypeRefusal` and `codeBlockRefusal`
 * are the toolbar's command layer, exported precisely so a second surface
 * carrying the same verbs refuses the same targets for the same reasons — a
 * figure that cannot become a heading must be unable to from every door.
 *
 * These read and write the SELECTION, not a position: the block menu puts the
 * writer on the block it was opened for before it renders, so "the selection"
 * and "the block under the handle" are the same thing by the time anything
 * here runs. That is what lets the toolbar's predicates answer for a block the
 * writer merely pointed at.
 *
 * A true toggle throughout (law 6): the current type carries a check, and
 * choosing it again returns the block to a paragraph.
 */

import type { Editor } from "@tiptap/core";

import {
  type BlockTypeRefusalReason,
  blockTypeRefusal,
  codeBlockRefusal,
  toggleBulletListBlock,
  toggleCodeBlockBlock,
  toggleHeadingBlock,
} from "../toolbar";

export type TurnIntoTargetId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "quote"
  | "codeBlock";

export type TurnIntoTarget = {
  id: TurnIntoTargetId;
  /** Lit when the block already is this (law 6). */
  active: boolean;
  /** Null when the conversion can run; a reason to grey with otherwise (law 5). */
  blockedBy: BlockTypeRefusalReason | null;
};

export const TURN_INTO_TARGET_IDS: readonly TurnIntoTargetId[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulletList",
  "orderedList",
  "quote",
  "codeBlock",
];

/** The three levels §5.7 and §5.8 offer; the schema allows more. */
const HEADING_LEVELS: Partial<Record<TurnIntoTargetId, 1 | 2 | 3>> = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
};

/**
 * Every conversion with its state and its refusal, for the block now under the
 * selection.
 *
 * Paragraph and Code block share the code fence's exception: a fence's only
 * conversions are the two that undo it, so `code-block` is a reversal target
 * for them rather than a refusal — the same exception the toolbar's own Code
 * button makes.
 */
export function turnIntoTargets(editor: Editor): TurnIntoTarget[] {
  const refusal = blockTypeRefusal(editor);
  const reversal = codeBlockRefusal(editor);

  return TURN_INTO_TARGET_IDS.map((id) => ({
    id,
    active: isTurnIntoActive(editor, id),
    blockedBy: id === "paragraph" || id === "codeBlock" ? reversal : refusal,
  }));
}

/** Run one conversion. False when the fence refused it, as the button warned. */
export function applyTurnInto(editor: Editor, id: TurnIntoTargetId): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;

  const level = HEADING_LEVELS[id];
  if (level !== undefined) {
    // Level 1 is the toolbar's own heading verb; the other two are the same
    // command at a different level, fenced by the same predicate.
    if (level === 1) return toggleHeadingBlock(editor);
    if (blockTypeRefusal(editor)) return false;
    return editor.chain().focus().toggleHeading({ level }).run();
  }

  switch (id) {
    case "paragraph":
      if (codeBlockRefusal(editor)) return false;
      return editor.chain().focus().setParagraph().run();
    case "bulletList":
      return toggleBulletListBlock(editor);
    case "orderedList":
      if (blockTypeRefusal(editor)) return false;
      return editor.chain().focus().toggleOrderedList().run();
    case "quote":
      if (blockTypeRefusal(editor)) return false;
      return editor.chain().focus().toggleBlockquote().run();
    case "codeBlock":
      return toggleCodeBlockBlock(editor);
    default:
      return false;
  }
}

function isTurnIntoActive(editor: Editor, id: TurnIntoTargetId): boolean {
  const level = HEADING_LEVELS[id];
  if (level !== undefined) return editor.isActive("heading", { level });

  switch (id) {
    case "paragraph":
      // A paragraph wrapped in a list or a quote is that list or that quote as
      // far as the writer is concerned, so the plainest type answers last.
      return (
        editor.isActive("paragraph") &&
        !editor.isActive("bullet_list") &&
        !editor.isActive("ordered_list") &&
        !editor.isActive("blockquote")
      );
    case "bulletList":
      return editor.isActive("bullet_list");
    case "orderedList":
      return editor.isActive("ordered_list");
    case "quote":
      return editor.isActive("blockquote");
    case "codeBlock":
      return editor.isActive("code_block");
    default:
      return false;
  }
}
