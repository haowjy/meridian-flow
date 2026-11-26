import { t } from "@lingui/core/macro";

import {
  type BlockTypeId,
  type BlockTypeRefusalReason,
  headingLevelOf,
  type ToolbarBlockedReason,
  type ToolbarControlId,
} from "./toolbar-commands";

export type BlockedSubject = ToolbarControlId | "block-type" | "mark" | "document";

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

export function blockTypeLabel(id: BlockTypeId): string {
  switch (id) {
    case "paragraph":
      return t`Paragraph`;
    case "bulletList":
      return t`Bulleted list`;
    case "orderedList":
      return t`Numbered list`;
    case "quote":
      return t`Quote`;
    case "codeBlock":
      return t`Code block`;
    default: {
      const level = headingLevelOf(id);
      return t`Heading ${level}`;
    }
  }
}

function isBlockTypeControl(control: BlockedSubject): boolean {
  return (
    control === "heading" ||
    control === "codeBlock" ||
    control === "bulletList" ||
    control === "block-type"
  );
}

export function blockTypeReasonMessage(reason: BlockTypeRefusalReason): string {
  switch (reason) {
    case "object-selection":
      return t`Select text to change the block type.`;
    case "code-block":
      return t`Code blocks keep their own block type.`;
    case "embedded-block":
      return t`Embedded blocks keep their own block type.`;
    case "mixed-selection":
      return t`This selection holds blocks that keep their own block type.`;
  }
}

export function blockedReasonMessage(
  control: BlockedSubject,
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
  }
}
