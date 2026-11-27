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

export function documentRow(name: string): NamedRow {
  const parsed = parseDocumentFilename(name);
  return { extension: parsed.ok ? parsed.value.extension : "", editable: true };
}

export function entryNameStemEnd(name: string, row?: NamedRow): number {
  return splitRendered(name, row?.extension ?? "").name.length;
}

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

export type ContextEntryNameSeverity = {
  level: "error" | "warning";
  message: string;
};

export function validateContextEntryName(
  raw: string,
  kind: ContextCreateKind = "file",
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
      message: t`Invalid name`,
    };
  }
  return null;
}
