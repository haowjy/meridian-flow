/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Library, NotebookPen, Upload, User } from "lucide-react";

import { ScrollQuill } from "./scroll-quill-icon";

/**
 * Ordered list of context schemes the UI surfaces, top to bottom. Project-scoped
 * schemes come first, then the work-scoped ones (`scratch`, `uploads`); all are
 * flush top-level panes (no work header row above the work-scoped pair —
 * ruling 2026-08-06; their headers carry the work name in a hover tooltip).
 */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = CONTEXT_URI_SCHEMES;

/** Schemes shown in the tree panel for the current work context. */
export function visibleContextSchemes(workId: string | null): readonly ProjectContextTreeScheme[] {
  return CONTEXT_SCHEMES.filter(
    (scheme) => !isWorkScopedProjectContextScheme(scheme) || workId !== null,
  );
}

/**
 * Whether the writer can create files/folders inside a scheme from a browse
 * surface. Uploads is intake only (Jimmy's ruling, 2026-08-06): its files
 * arrive by uploading, never by in-tree creation, so no surface offers
 * New file / New folder there. Scratch is the work's authoring space.
 */
export function schemeAllowsCreation(scheme: ProjectContextTreeScheme): boolean {
  return scheme !== "uploads";
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
