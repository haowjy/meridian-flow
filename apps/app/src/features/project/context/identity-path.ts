/**
 * Human-path grammar for the document identity bar.
 *
 * The bar's typed surfaces speak writer paths (`Manuscript/Act 2/chapter-12`):
 * root segment is a scheme's writer-visible label, separators are `/`, never
 * URIs or work ids. This module owns parsing/formatting that grammar against
 * the live context tree: case-insensitive root + folder resolution, canonical
 * casing, and which typed folders don't exist yet (create-on-move).
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import { schemeLabel } from "./context-schemes";
import { type FileSuggestion, folderChildren } from "./file-suggestions";

/** Writing destinations a document can be moved into (uploads/user are not
 *  writing homes — same exclusion as the destination browser). */
export const MOVE_DESTINATION_SCHEMES: readonly ProjectContextTreeScheme[] = [
  "manuscript",
  "kb",
  "scratch",
];

/** Roots the typed path may name: every destination plus the document's own
 *  scheme, so an unchanged path always parses. */
export function humanPathRoots(current: ProjectContextTreeScheme): ProjectContextTreeScheme[] {
  return MOVE_DESTINATION_SCHEMES.includes(current)
    ? [...MOVE_DESTINATION_SCHEMES]
    : [...MOVE_DESTINATION_SCHEMES, current];
}

/** Case-insensitive root-label match: `manuscript` → the `manuscript` scheme. */
export function matchRootLabel(
  raw: string,
  roots: readonly ProjectContextTreeScheme[],
): ProjectContextTreeScheme | null {
  const needle = raw.trim().toLocaleLowerCase();
  return roots.find((scheme) => schemeLabel(scheme).toLocaleLowerCase() === needle) ?? null;
}

export type CanonicalFolders = {
  /** Typed segments with existing folders corrected to canonical casing. */
  canonical: string[];
  /** Indexes (into `canonical`) of segments that don't exist yet. */
  missing: number[];
  /** Tree-style parent path (`/a/b`, `/` for root) of the RESOLVED prefix —
   *  the deepest existing folder the typed path descends through. */
  resolvedPath: string;
};

/**
 * Walk typed folder segments against the tree. Existing folders match
 * case-insensitively and are canonicalized; once a segment has no match,
 * it and everything after it are new folders (their children are unknown).
 */
export function canonicalizeFolders(
  entries: readonly FileSuggestion[],
  scheme: ProjectContextTreeScheme,
  segments: readonly string[],
): CanonicalFolders {
  const canonical: string[] = [];
  const missing: number[] = [];
  let parent = "/";
  let unresolved = false;
  segments.forEach((segment, index) => {
    const typed = segment.trim();
    const match = unresolved
      ? undefined
      : folderChildren(entries, scheme, parent).find(
          (child) =>
            child.kind === "dir" && child.name.toLocaleLowerCase() === typed.toLocaleLowerCase(),
        );
    if (match) {
      canonical.push(match.name);
      parent = match.path;
    } else {
      canonical.push(typed);
      missing.push(index);
      unresolved = true;
    }
  });
  return { canonical, missing, resolvedPath: parent };
}

export type HumanPathTarget = {
  scheme: ProjectContextTreeScheme;
  /** Canonicalized folder segments (missing ones as typed). */
  folders: string[];
  /** Folder names that will be created by the move. */
  newFolders: string[];
  leaf: string;
};

export function formatHumanPath(
  scheme: ProjectContextTreeScheme,
  folders: readonly string[],
  leaf: string,
): string {
  return [schemeLabel(scheme), ...folders, leaf].join("/");
}

/** The caret's segment within a `/`-joined value. */
export function segmentAtCaret(
  value: string,
  caret: number,
): { index: number; start: number; end: number; text: string } {
  const segments = value.split("/");
  let start = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const text = segments[index] ?? "";
    const end = start + text.length;
    if (caret <= end || index === segments.length - 1) {
      return { index, start, end, text };
    }
    start = end + 1;
  }
  return { index: 0, start: 0, end: value.length, text: value };
}
