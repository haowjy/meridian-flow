/** Shared naming logic for inline context-entry create rows. */
import { t } from "@lingui/core/macro";
import {
  type ContextEntryValidationError,
  validateContextEntryName as validateSharedContextEntryName,
} from "@meridian/contracts/context-entry-validation";
import {
  filenameCandidates,
  type NamedRow,
  parseDocumentFilename,
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

function validationReason(error: ContextEntryValidationError): string {
  switch (error.reason) {
    case "name/empty":
      return t`Name is required`;
    case "name/reserved":
      return t`'.' and '..' cannot be used as names`;
    case "name/reserved-authority-qualifier":
      return t`Names cannot begin with '@' or '~'. Those prefixes are reserved for authority qualifiers`;
    case "name/invalid-character":
      return t`Names cannot contain “${error.character ?? ""}”`;
    case "path/empty-segment":
      return t`Names cannot be empty`;
    case "path/unknown-root":
      return t`That location does not exist`;
    case "path/trailing-separator":
      return t`Names cannot end with '/'`;
  }
}

export function joinContextEntryPath(parent: string, leaf: string): string {
  const prefix = parent && parent !== "/" ? parent.replace(/\/+$/, "") : "";
  return `${prefix}/${leaf}`;
}

export function parentContextEntryPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** Why a typed document name is refused, or null; `current` is the row being renamed. */
export function invalidContextEntryNameReason(name: string, current?: NamedRow): string | null {
  const result = validateSharedContextEntryName(name);
  if (!result.ok) return validationReason(result);
  const stored = storedFilename(result.value, current);
  return stored.ok ? null : stored.message;
}

/** Live severity for the desktop tree's inline create/rename input, shown as a floating overlay (never inline, so rows don't shift). */
export type ContextEntryNameSeverity = {
  level: "error" | "warning";
  message: string;
};

export function contextEntryConflictMessage(
  name: string,
  occupantKind?: "file" | "folder",
): string {
  if (occupantKind === "folder") return t`A folder named ${name} already exists in this location.`;
  if (occupantKind === "file") return t`A file named ${name} already exists in this location.`;
  return t`An entry named ${name} already exists in this location.`;
}

export type ContextEntrySibling = { entryId: string; name: string; kind: "file" | "dir" };

export function validateContextEntryName(
  raw: string,
  siblings: readonly ContextEntrySibling[],
  kind: ContextCreateKind = "file",
  /** The file being renamed; absent when creating. */
  current?: NamedRow,
): ContextEntryNameSeverity | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const validation = validateSharedContextEntryName(trimmed);
  if (!validation.ok) return { level: "error", message: validationReason(validation) };
  let candidate = trimmed;
  if (kind === "file") {
    const stored = storedFilename(trimmed, current);
    if (!stored.ok) return { level: "error", message: stored.message };
    candidate = stored.name;
  }
  // Siblings clash on the literal rendered name, whatever their kinds.
  const occupant = siblings.find((sibling) => sibling.name === candidate);
  if (occupant) {
    return {
      level: "error",
      message: contextEntryConflictMessage(candidate, occupant.kind === "dir" ? "folder" : "file"),
    };
  }
  if (raw !== trimmed) {
    return {
      level: "warning",
      message: t`Leading or trailing whitespace detected in file or folder name.`,
    };
  }
  return null;
}

/** A move retry preserves the complete refused intent, including a queued rename. */
export function moveEntryName(currentName: string, repair?: { name: string }): string {
  return repair?.name ?? currentName;
}

/** The names a folder's rows hold, as the tree renders them. Siblings of either kind clash on equal names. */
export function nameOccupancy(siblings: readonly ContextEntrySibling[]): Set<string> {
  return new Set(siblings.map((sibling) => sibling.name));
}

/** Predict the first free name for a rename or move; the server remains authoritative. */
export function allocateContextEntryArrivalName(
  typed: string,
  occupied: ReadonlySet<string>,
  kind: ContextCreateKind,
  current?: NamedRow,
): string {
  const stored = kind === "folder" ? null : storedFilename(typed, current);
  if (stored && !stored.ok) return typed.trim();
  const desired = stored
    ? { name: stored.filename.name, extension: stored.filename.extension }
    : { name: typed.trim() };
  for (const candidate of filenameCandidates(desired))
    if (!occupied.has(candidate)) return candidate;
  throw new Error("unreachable");
}
