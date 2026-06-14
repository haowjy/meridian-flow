// @ts-nocheck
/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { BookOpen, Brain, Terminal, User } from "lucide-react";

/**
 * The ordered list of context schemes the UI surfaces. Wire values
 * (`"kb" | "work" | "user" | "fs1"`) match the server's `ProjectContextTreeScheme`
 * and never change — only the human-facing label varies (and is localized).
 *
 * Order is the display order (KB → User → Work → Project Workspace Files) used by both the mobile
 * drill-down list and the desktop sidebar sections.
 */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = ["kb", "user", "work", "fs1"];

/**
 * Localized label for a scheme. Resolved at call time so Lingui's macro
 * picks up the active locale rather than the locale at module load.
 */
export function schemeLabel(scheme: ProjectContextTreeScheme): string {
  switch (scheme) {
    case "kb":
      return t`Knowledge Base`;
    case "user":
      return t`User Files`;
    case "work":
      return t`Work Memory`;
    case "fs1":
      return t`Project Workspace Files`;
  }
}

/**
 * Identity icon for a scheme. Schemes are context *sources*, not folders —
 * curated knowledge, the user's uploads, the agent's working memory, and the
 * compute project workspace — so each gets a semantic icon instead of a generic folder
 * (folder icons are reserved for actual directories inside a scheme).
 */
export function schemeIcon(scheme: ProjectContextTreeScheme): LucideIcon {
  switch (scheme) {
    case "kb":
      return BookOpen;
    case "user":
      return User;
    case "work":
      return Brain;
    case "fs1":
      return Terminal;
  }
}
