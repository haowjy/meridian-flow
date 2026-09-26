/** Shared naming logic for inline context-entry create rows. */
import { t } from "@lingui/core/macro";
import {
  type ContextEntryValidationError,
  validateContextEntryName as validateSharedContextEntryName,
} from "@meridian/contracts/context-entry-validation";
import type { ContextCreateKind } from "./context-create-kind";

function validationReason(error: ContextEntryValidationError): string {
  switch (error.reason) {
    case "name/empty":
      return t`Name is required`;
    case "name/reserved":
      return t`'.' and '..' cannot be used as names`;
    case "name/reserved-authority-qualifier":
      return t`Names cannot begin with '@'. That prefix is reserved for authority qualifiers`;
    case "name/invalid-character":
      return t`Names cannot contain '${error.character ?? ""}'`;
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

export function invalidContextEntryNameReason(name: string): string | null {
  const result = validateSharedContextEntryName(name);
  return result.ok ? null : validationReason(result);
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
): ContextEntryNameSeverity | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const validation = validateSharedContextEntryName(trimmed);
  if (!validation.ok) return { level: "error", message: validationReason(validation) };
  const collides = siblingNames.some((name) => name.replace(/\/$/, "") === trimmed);
  if (collides) {
    return {
      level: "error",
      message:
        kind === "folder"
          ? t`A folder named ${trimmed} already exists in this location.`
          : t`A file named ${trimmed} already exists in this location.`,
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
