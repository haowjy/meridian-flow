/** Shared normalization and validation for writer-visible context names and paths. */

export type ContextEntryValidationReason =
  | "name/empty"
  | "name/invalid-character"
  | "name/reserved"
  | "path/empty-segment"
  | "path/unknown-root"
  | "path/trailing-separator";

export type ContextEntryValidationError = {
  ok: false;
  reason: ContextEntryValidationReason;
  segment?: string;
  character?: string;
};

export type ContextEntryValidationResult =
  | { ok: true; value: string }
  | ContextEntryValidationError;

const INVALID_NAME_CHARACTER = /[/\\:*?"<>|]/;

/** Trims and validates one filesystem entry name. */
export function validateContextEntryName(raw: string): ContextEntryValidationResult {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "name/empty" };
  if (value === "." || value === "..") {
    return { ok: false, reason: "name/reserved", segment: value };
  }
  const invalid = [...value].find(
    (character) => character.charCodeAt(0) < 32 || INVALID_NAME_CHARACTER.test(character),
  );
  if (invalid) {
    return {
      ok: false,
      reason: "name/invalid-character",
      segment: value,
      character: invalid,
    };
  }
  return { ok: true, value };
}

export type ValidateContextEntryPathOptions = {
  /** The empty string is the canonical scheme-root folder path. */
  allowRoot?: boolean;
  /** When supplied, the first segment is a writer-visible root label. */
  knownRoots?: readonly string[];
};

/** Trims every segment while preserving malformed separators as typed errors. */
export function validateContextEntryPath(
  raw: string,
  options: ValidateContextEntryPathOptions = {},
): ContextEntryValidationResult {
  if (raw === "" && options.allowRoot) return { ok: true, value: "" };
  if (raw.endsWith("/")) return { ok: false, reason: "path/trailing-separator" };

  const segments = raw.split("/");
  if (segments.some((segment) => segment.trim() === "")) {
    return { ok: false, reason: "path/empty-segment" };
  }

  const normalized: string[] = [];
  for (const segment of segments) {
    const result = validateContextEntryName(segment);
    if (!result.ok) return result;
    normalized.push(result.value);
  }

  if (options.knownRoots && !options.knownRoots.includes(normalized[0] ?? "")) {
    return { ok: false, reason: "path/unknown-root", segment: normalized[0] };
  }
  return { ok: true, value: normalized.join("/") };
}
