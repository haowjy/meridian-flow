/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import {
  CONTEXT_URI_SCHEMES,
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Library, NotebookPen, Upload, User } from "lucide-react";

import { ScrollQuill } from "./scroll-quill-icon";

/** Complete vocabulary for references and tools, including chat resources. */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = CONTEXT_URI_SCHEMES;

/** Ordinary Editor surfaces contain only project documents. */
export const EDITOR_CONTEXT_SCHEMES = PROJECT_SCOPED_CONTEXT_URI_SCHEMES;

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
    case "unfiled":
      return t`Unfiled`;
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
    case "unfiled":
    case "scratch":
      return NotebookPen;
    case "uploads":
      return Upload;
  }
}
