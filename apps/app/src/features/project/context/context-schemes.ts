/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { BookOpen, Brain, FileText, User } from "lucide-react";

/** Ordered list of context schemes the UI surfaces (matches `ProjectContextTreeScheme`). */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = [
  "manuscript",
  "kb",
  "user",
  "work",
];

export function schemeLabel(scheme: ProjectContextTreeScheme): string {
  switch (scheme) {
    case "manuscript":
      return t`Manuscript`;
    case "kb":
      return t`Knowledge Base`;
    case "user":
      return t`User Files`;
    case "work":
      return t`Work Memory`;
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
    case "work":
      return Brain;
    case "uploads":
      return FileText;
  }
}
