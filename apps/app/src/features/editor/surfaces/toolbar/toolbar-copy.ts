/**
 * Writer-facing copy for the toolbar's controls and, more importantly, for the
 * reasons they grey out. Law 5 is only satisfied when the reason reads as an
 * answer ("select text to format it"), so the copy lives in one place where
 * the whole matrix can be read at once.
 */
import { t } from "@lingui/core/macro";

import type { ToolbarBlockedReason, ToolbarControlId } from "./toolbar-commands";

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
    case "code":
      return t`Code`;
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
      if (control === "heading" || control === "bulletList") {
        return t`Select text to change the block type.`;
      }
      return t`Select text to format it.`;
    case "code-block":
      if (control === "heading" || control === "bulletList") {
        return t`Code blocks keep their own block type.`;
      }
      return t`Code blocks take no formatting.`;
    case "no-alignable-block":
      return t`Alignment applies to paragraphs, headings, and tables.`;
    case "empty-history":
      return control === "redo" ? t`Nothing to redo yet.` : t`Nothing to undo yet.`;
    case "no-project":
      return t`Open this document in a project to upload figures.`;
    case "upload-in-flight":
      return t`A figure is uploading.`;
  }
}
