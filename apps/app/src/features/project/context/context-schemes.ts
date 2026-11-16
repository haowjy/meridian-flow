/**
 * Context scheme presentation contract: lists the server-supported context tree
 * schemes in sidebar display order and maps wire values to localized labels
 * and identity icons.
 */
import { t } from "@lingui/core/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import {
  CONTEXT_URI_SCHEMES,
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";

import { familyIcon } from "@/components/app/link-chip/family-icons";

/** Complete vocabulary for references and tools, including chat resources. */
export const CONTEXT_SCHEMES: readonly ProjectContextTreeScheme[] = CONTEXT_URI_SCHEMES;

/** Ordinary Editor surfaces hold project-scoped documents: the project's areas and the writer's User. */
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

/**
 * The area a path is in, and the path inside it. The writer's Agents level is a folder of Your
 * files, but every screen names it as the Agents tab does: `~/.agents`.
 */
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

/** Where something lives, for a row's second line: the source, then the folders down to it. */
export function schemeLocation(scheme: ProjectContextTreeScheme, folders: readonly string[]) {
  const { area, rest } = areaOf(scheme, folders.join("/"));
  return [area, ...rest.split("/").filter(Boolean)].join(" / ");
}

/** Where the document at `path` lives (or lived, for one in Trash): its source and folders. */
export function documentPlace(scheme: ProjectContextTreeScheme, path: string) {
  return schemeLocation(scheme, path.split("/").filter(Boolean).slice(0, -1));
}

/** The area's name, as the sidebar shows it; null for a source that is unknown. */
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
      // The writer, the model and stored text spell the project's Agents folder this way.
      return ".agents";
  }
}

/**
 * Where a document lives, as the `@` menu says it: its folder, after the area
 * unless that is the manuscript. Empty for a manuscript document at the root.
 */
export function documentLocation(scheme: ProjectContextTreeScheme, folderPath: string): string {
  if (scheme === "manuscript") return folderPath;
  const { area, rest } = areaOf(scheme, folderPath);
  return rest ? `${area}/${rest}` : area;
}

/**
 * Icons distinguish the current project-context resource families. The same
 * shapes mark a link chip's family; both read `family-icons.ts`.
 */
export function schemeIcon(scheme: ProjectContextTreeScheme): LucideIcon {
  return familyIcon(scheme);
}
