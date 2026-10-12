/** Shared naming logic for inline context-entry create rows. */
import { t } from "@lingui/core/macro";
import {
  type ContextEntryValidationError,
  validateContextEntryName as validateSharedContextEntryName,
} from "@meridian/contracts/context-entry-validation";
import {
  parseDocumentFilename,
  renderFilename,
  storedFilename,
} from "@meridian/contracts/protocol";
import type { ContextCreateKind } from "./context-create-kind";

/**
 * What two sibling names clash on. A folder compares as a document name, so a
 * folder `Lore.md` and a document `Lore` are one name and cannot coexist.
 */
export function entryNameKey(name: string): string {
  const bare = name.trim().replace(/\/$/, "");
  const parsed = parseDocumentFilename(bare);
  return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : bare;
}

/** Where the part a writer renames ends: before a visible extension, otherwise the whole name. */
export function entryNameStemEnd(name: string, kind: ContextCreateKind = "file"): number {
  if (kind === "folder") return name.length;
  const parsed = parseDocumentFilename(name);
  const extension = parsed.ok ? parsed.value.extension : "";
  return extension && name.toLowerCase().endsWith(`.${extension}`)
    ? name.length - extension.length - 1
    : name.length;
}

function validationReason(error: ContextEntryValidationError): string {
  switch (error.reason) {
    case "name/empty":
      return t`Name is required`;
    case "name/reserved":
      return t`'.' and '..' cannot be used as names`;
    case "name/reserved-authority-qualifier":
      return t`Names cannot begin with '@'. That prefix is reserved for authority qualifiers`;
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

/** Why a typed document name is refused, or null; `current` is the stored name being renamed. */
export function invalidContextEntryNameReason(name: string, current?: string): string | null {
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
  /** The stored name of the file being renamed; absent when creating. */
  current?: string,
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
  const key = entryNameKey(candidate);
  const occupant = siblings.find((sibling) =>
    kind === "folder" && sibling.kind === "dir"
      ? sibling.name === candidate
      : entryNameKey(sibling.name) === key,
  );
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
