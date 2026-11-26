import { t } from "@lingui/core/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import {
  CONTEXT_URI_SCHEME_NAMES,
  CONTEXT_URI_SCHEMES,
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";

import { familyIcon } from "@/components/app/link-chip/family-icons";

export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = CONTEXT_URI_SCHEMES;

export const EDITOR_CONTEXT_SCHEMES = PROJECT_SCOPED_CONTEXT_URI_SCHEMES;

/**
 * Whether the writer can create files/folders inside a scheme from a browse
 * surface. Uploads is intake only (Jimmy's ruling, 2026-08-06): its files
 * arrive by uploading, never by in-tree creation. Scratch notes are made only
 * from a Work's Files tab (New note) and by the AI (owner, 2026-10-05), so no
 * Editor surface offers New file / New folder there either.
 */
export function schemeAllowsCreation(scheme: ProjectContextTreeScheme): boolean {
  return scheme !== "uploads" && scheme !== "scratch";
}

export function areaOf(
  scheme: ProjectContextTreeScheme,
  path: string,
): { area: string; rest: string } {
  const trimmed = path.replace(/^\/+/, "");
  const at = scheme === "user" ? agentsLocationOf(scheme, trimmed.replace(/\/$/, "")) : null;
  if (at)
    return { area: "~/.agents", rest: at.path ? trimmed.slice(trimmed.indexOf("/") + 1) : "" };
  return { area: schemeLabel(scheme), rest: trimmed };
}

export function schemeLocation(scheme: ProjectContextTreeScheme, folders: readonly string[]) {
  const { area, rest } = areaOf(scheme, folders.join("/"));
  return [area, ...rest.split("/").filter(Boolean)].join(" / ");
}

export function documentPlace(scheme: ProjectContextTreeScheme, path: string) {
  return schemeLocation(scheme, path.split("/").filter(Boolean).slice(0, -1));
}

export function schemeLabel(scheme: ProjectContextTreeScheme): string;
export function schemeLabel(scheme: ProjectContextTreeScheme | null | undefined): string | null;
export function schemeLabel(scheme: ProjectContextTreeScheme | null | undefined): string | null {
  switch (scheme) {
    case null:
    case undefined:
      return null;
    case "manuscript":
      return t`Manuscript`;
    case "kb":
      return t`Knowledge`;
    case "user":
      return t`Your files`;
    case "unfiled":
      return t`Unfiled`;
    case "scratch":
      return t`Scratch`;
    case "uploads":
      return t`Uploads`;
    case "agents":
      return CONTEXT_URI_SCHEME_NAMES.agents;
  }
}

export function documentLocation(scheme: ProjectContextTreeScheme, folderPath: string): string {
  if (scheme === "manuscript") return folderPath;
  const { area, rest } = areaOf(scheme, folderPath);
  return rest ? `${area}/${rest}` : area;
}

export function schemeIcon(scheme: ProjectContextTreeScheme): LucideIcon {
  return familyIcon(scheme);
}
