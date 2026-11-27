import { parseDocumentFilename, renderFilename } from "./protocol/document-filename.js";
import { readSegment, SEGMENT_SUFFIX, withSegmentName } from "./protocol/entry-segment.js";

export type ContextEntryValidationReason =
  | "name/empty"
  | "path/empty-segment"
  | "path/unknown-root"
  | "path/trailing-separator";

export type ContextEntryValidationError = {
  ok: false;
  reason: ContextEntryValidationReason;
  segment?: string;
};

export type ContextEntryValidationResult =
  | { ok: true; value: string }
  | ContextEntryValidationError;

const MAX_NAME = 255;
const UNTITLED = "Untitled";
const withoutControls = (text: string) =>
  [...text]
    .map((char) => ((char.codePointAt(0) as number) <= 0x1f || char === "\u007f" ? " " : char))
    .join("");
const LOOK_ALIKE: Record<string, string> = { "/": "\u2215", "@": "\uff20", "~": "\uff5e" };

// NormalEntryName is frozen; changing its output changes replay of stored tree history and needs a migration
export function normalEntryName(kind: "document" | "folder", typed: string): string {
  let name = withoutControls(typed)
    .trim()
    .replaceAll("/", LOOK_ALIKE["/"] as string);
  const first = name[0];
  if (first === "@" || first === "~") name = (LOOK_ALIKE[first] as string) + name.slice(1);
  if (name === "." || name === "..") name = name.replaceAll(".", "\uff0e");
  if (name.length > MAX_NAME) {
    let cut = "";
    for (const char of name) {
      if (cut.length + char.length > MAX_NAME) break;
      cut += char;
    }
    name = cut.trimEnd();
  }
  if (kind === "document" && name) {
    const parsed = parseDocumentFilename(name);
    if (parsed.ok) name = renderFilename(parsed.value.name, parsed.value.extension);
    else if (parsed.error.message.startsWith("A document name")) name = "";
  }
  return (name || UNTITLED)
    .replace(/@(?=(?:live|draft|[wcbp]\d+)$)/i, LOOK_ALIKE["@"] as string)
    .replace(SEGMENT_SUFFIX, (suffix) => (LOOK_ALIKE["~"] as string) + suffix.slice(1));
}

export function validateContextEntryName(raw: string): ContextEntryValidationResult {
  if (!raw.trim()) return { ok: false, reason: "name/empty" };
  return { ok: true, value: normalEntryName("folder", raw) };
}

export type ValidateContextEntryPathOptions = {
  allowRoot?: boolean;
  knownRoots?: readonly string[];
};

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
    const trimmed = segment.trim();
    normalized.push(
      readSegment(trimmed).name.trim()
        ? withSegmentName(trimmed, (name) => normalEntryName("folder", name))
        : normalEntryName("folder", trimmed),
    );
  }

  if (options.knownRoots && !options.knownRoots.includes(normalized[0] ?? "")) {
    return { ok: false, reason: "path/unknown-root", segment: normalized[0] };
  }
  return { ok: true, value: normalized.join("/") };
}
