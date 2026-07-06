/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { BookOpen, Brain, FileText, User } from "lucide-react";

/** Ordered list of context schemes the UI may surface (matches `ProjectContextTreeScheme`). */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = [
  "manuscript",
  "kb",
  "user",
  "scratch",
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
      return t`User Files`;
    case "scratch":
      return t`Scratch`;
    case "uploads":
      return t`Uploads`;
  }
}

export function schemeIcon(scheme: ProjectContextTreeScheme): LucideIcon {
  switch (scheme) {
    case "manuscript":
      return FileText;
    case "kb":
      return BookOpen;
    case "user":
      return User;
    case "scratch":
      return Brain;
    case "uploads":
      return FileText;
  }
}
