/**
 * Writer-facing copy for the toolbar's controls and, more importantly, for the
 * reasons they grey out. Law 5 is only satisfied when the reason reads as an
 * answer ("select text to format it"), so the copy lives in one place where
 * the whole matrix can be read at once.
 */
import { t } from "@lingui/core/macro";

import type {
  BlockTypeRefusalReason,
  ToolbarBlockedReason,
  ToolbarControlId,
} from "./toolbar-commands";

export function toolbarControlLabel(control: ToolbarControlId): string {
  switch (control) {
    case "undo":
      return t`Undo`;
    case "redo":
      return t`Redo`;
    case "heading":
      return t`Heading`;
    case "bold":
      return t`Bold`;
    case "italic":
      return t`Italic`;
    case "codeBlock":
      return t`Code block`;
    case "bulletList":
      return t`Bullet list`;
    case "link":
      return t`Link`;
    case "alignment":
      return t`Block alignment`;
    case "uploadFigure":
      return t`Upload figure`;
  }
}

/** Heading, code block, and bullet list all rewrite the block they sit on. */
function isBlockTypeControl(control: ToolbarControlId): boolean {
  return control === "heading" || control === "codeBlock" || control === "bulletList";
}

/**
 * Why a whole-block conversion cannot run on this target. Shared with every
 * surface carrying the same verbs — the block menu's Turn into — so one
 * refusal reads the same wherever the writer meets it.
 */
export function blockTypeReasonMessage(reason: BlockTypeRefusalReason): string {
  switch (reason) {
    case "object-selection":
      return t`Select text to change the block type.`;
    case "code-block":
      return t`Code blocks keep their own block type.`;
    case "embedded-block":
      return t`Embedded blocks keep their own block type.`;
    case "mixed-selection":
      return t`Part of this selection keeps its own block type.`;
    case "table-cell":
      return t`Table cells hold plain paragraphs.`;
  }
}

export function blockedReasonMessage(
  control: ToolbarControlId,
  reason: ToolbarBlockedReason | null,
): string | null {
  if (!reason) return null;
  switch (reason) {
    case "editor-loading":
      return t`This document is still opening.`;
    case "document-read-only":
      return t`This document is read only right now.`;
    case "object-selection":
      if (control === "link") return t`Select text to add a link.`;
      if (isBlockTypeControl(control)) return blockTypeReasonMessage(reason);
      return t`Select text to format it.`;
    case "code-block":
      if (isBlockTypeControl(control)) return blockTypeReasonMessage(reason);
      if (control === "link") return t`Code blocks take no links.`;
      return t`Code blocks take no formatting.`;
    case "embedded-block":
      if (isBlockTypeControl(control)) return blockTypeReasonMessage(reason);
      if (control === "link") return t`Embedded blocks take no links.`;
      return t`Embedded blocks take no formatting.`;
    case "mixed-selection":
    case "table-cell":
      return blockTypeReasonMessage(reason);
    case "inline-code":
      return control === "link"
        ? t`Inline code takes no links.`
        : t`Inline code takes no other formatting.`;
    case "no-alignable-block":
      return t`Alignment applies to paragraphs, headings, and tables.`;
    case "empty-history":
      return control === "redo" ? t`Nothing to redo yet.` : t`Nothing to undo yet.`;
    case "code-document":
      return t`This file holds code only.`;
    case "no-project":
      return t`Open this document in a project to upload figures.`;
    case "upload-in-flight":
      return t`A figure is uploading.`;
  }
}
