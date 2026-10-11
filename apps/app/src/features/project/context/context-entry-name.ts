/** Shared naming logic for inline context-entry create rows. */
import { t } from "@lingui/core/macro";
import {
  type ContextEntryValidationError,
  validateContextEntryName as validateSharedContextEntryName,
} from "@meridian/contracts/context-entry-validation";
import {
  classifyFiletype,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";
import type { ContextCreateKind } from "./context-create-kind";

/**
 * The name a typed file name is stored under, by the one codec in contracts:
 * `Chapter 13.md` and `notes.txt` store `Chapter 13` and `notes`, `outline.json`
 * keeps its extension, `Vol. 2` is a name. `current` is the stored name of the
 * file being renamed, so an extensionless `settings` renaming `config.toml`
 * stays `settings.toml`. The codec's `invalid_name` message passes through.
 */
export function storedEntryName(
  raw: string,
  current?: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const source = current ? parseDocumentFilename(current) : null;
  const sourceExtension = source?.ok ? source.value.extension : "";
  const parsed = parseDocumentFilename(raw, {
    sourceExtension,
    binary:
      Boolean(sourceExtension) &&
      classifyFiletype(source?.ok ? source.value.filetype : null).kind === "binary",
  });
  return parsed.ok
    ? { ok: true, name: renderFilename(parsed.value.name, parsed.value.extension) }
    : { ok: false, message: parsed.error.message };
}

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
  const stored = storedEntryName(result.value, current);
  return stored.ok ? null : stored.message;
}

/** Live severity for the desktop tree's inline create/rename input, shown as a floating overlay (never inline, so rows don't shift). */
export type ContextEntryNameSeverity = {
  level: "error" | "warning";
  message: string;
};

export function validateContextEntryName(
  raw: string,
  siblingNames: readonly string[],
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
    const stored = storedEntryName(trimmed, current);
    if (!stored.ok) return { level: "error", message: stored.message };
    candidate = stored.name;
  }
  const key = entryNameKey(candidate);
  if (siblingNames.some((name) => entryNameKey(name) === key)) {
    return {
      level: "error",
      message:
        kind === "folder"
          ? t`A folder named ${candidate} already exists in this location.`
          : t`A file named ${candidate} already exists in this location.`,
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
