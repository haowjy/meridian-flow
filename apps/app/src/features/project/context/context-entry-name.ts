/** Shared naming logic for inline context-entry create rows. */
import { t } from "@lingui/core/macro";
import { normalEntryName } from "@meridian/contracts/context-entry-validation";
import {
  type NamedRow,
  parseDocumentFilename,
  type StoredFilenameResult,
  splitRendered,
  storedFilename,
} from "@meridian/contracts/protocol";
import type { ContextCreateKind } from "./context-create-kind";

/** A tracked document's naming facts from its canonical name: a registered suffix is its own. */
export function documentRow(name: string): NamedRow {
  const parsed = parseDocumentFilename(name);
  return { extension: parsed.ok ? parsed.value.extension : "", editable: true };
}

/** Where the part a writer renames ends: before the row's extension, otherwise the whole name. */
export function entryNameStemEnd(name: string, row?: NamedRow): number {
  return splitRendered(name, row?.extension ?? "").name.length;
}

/**
 * What a typed document name is stored as: the row's extension kept (`storedFilename`), and a
 * name the codec can't hold turned into one by `normalEntryName` (no stem is "Untitled"), so no
 * document name is refused. Only a stored file's own rule (a kept prose file keeps its suffix)
 * still answers `ok: false`.
 */
export function storedDocumentName(typed: string, current?: NamedRow): StoredFilenameResult {
  const stored = storedFilename(typed, current);
  if (stored.ok || (current && !current.editable)) return stored;
  const name = normalEntryName("document", typed);
  const normal = storedFilename(name, current);
  // A name that would read as another type (`data.json.md`) is kept whole, as the replay keeps it.
  return normal.ok ? normal : { ok: true, name, filename: { name, extension: "", filetype: null } };
}

export function joinContextEntryPath(parent: string, leaf: string): string {
  const prefix = parent && parent !== "/" ? parent.replace(/\/+$/, "") : "";
  return `${prefix}/${leaf}`;
}

export function parentContextEntryPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** Live severity for the desktop tree's inline create/rename input, shown as a floating overlay (never inline, so rows don't shift). */
export type ContextEntryNameSeverity = {
  level: "error" | "warning";
  message: string;
};

/** A name never clashes: one a sibling has makes a twin. Only the codec and whitespace speak. */
export function validateContextEntryName(
  raw: string,
  kind: ContextCreateKind = "file",
  /** The file being renamed; absent when creating. */
  current?: NamedRow,
): ContextEntryNameSeverity | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (kind === "file") {
    const stored = storedDocumentName(trimmed, current);
    if (!stored.ok) return { level: "error", message: stored.message };
  }
  if (raw !== trimmed) {
    return {
      level: "warning",
      message: t`Leading or trailing whitespace detected in file or folder name.`,
    };
  }
  return null;
}
