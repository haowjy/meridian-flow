/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Library, NotebookPen, Upload, User } from "lucide-react";

import { ScrollQuill } from "./scroll-quill-icon";

/**
 * Ordered list of context schemes the UI surfaces, top to bottom. Project-scoped
 * schemes come first, then the work-scoped ones (`scratch`, `uploads`) below the
 * work boundary divider the tree draws before the first work-scoped section.
 */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = [
  "manuscript",
  "kb",
  "user",
  "scratch",
  "uploads",
];

/** Schemes shown in the tree panel for the current work context. */
export function visibleContextSchemes(workId: string | null): readonly ProjectContextTreeScheme[] {
  return CONTEXT_SCHEMES.filter(
    (scheme) => !isWorkScopedProjectContextScheme(scheme) || workId !== null,
  );
}

export function schemeLabel(scheme: ProjectContextTreeScheme): string {
  switch (scheme) {
    case "manuscript":
      return t`Manuscript`;
    case "kb":
      return t`Knowledge Base`;
    case "user":
      return t`User`;
    case "scratch":
      return t`Scratch`;
    case "uploads":
      return t`Uploads`;
  }
}

/**
 * Identity icons re-derived 2026-07 after two scheme renames left glyphs on
 * concepts that no longer exist (Brain was "Work Memory", FileText left the
 * manuscript indistinct from its own file rows). The book of the product
 * gets the quill-and-scroll; kb is the reference shelf; scratch is the
 * work-scoped scratchpad.
 */
export function schemeIcon(scheme: ProjectContextTreeScheme): LucideIcon {
  switch (scheme) {
    case "manuscript":
      return ScrollQuill;
    case "kb":
      return Library;
    case "user":
      return User;
    case "scratch":
      return NotebookPen;
    case "uploads":
      return Upload;
  }
}
