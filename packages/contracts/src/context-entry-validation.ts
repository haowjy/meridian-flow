/** Shared normalization and validation for writer-visible context names and paths. */

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
/** A control character: C0 or DEL. */
const withoutControls = (text: string) =>
  [...text]
    .map((char) => ((char.codePointAt(0) as number) <= 0x1f || char === "\u007f" ? " " : char))
    .join("");
// Look-alikes for what a path cannot carry: the slash is the separator, a leading `@` or `~`
// opens an owner or branch qualifier, and `.` / `..` are navigation.
const LOOK_ALIKE: Record<string, string> = { "/": "\u2215", "@": "\uff20", "~": "\uff5e" };

/**
 * The one name every client, the replay, the routes and the tools store for what a writer typed.
 * Total: any text gives a name, so no name is refused. A document's name is its codec spelling
 * (`notes.md` is `notes`); a name with no stem is "Untitled".
 *
 * Two endings are address syntax, so a stored name may never end in them (the `@` or `~` is
 * turned into the look-alike): a version on a path is `@live`, `@draft` or `@` and a handle (`@w5`,
 * `@c12`, `@b7`, `@p3`: a letter w, c, b or p and digits), matched without regard to case, as in
 * `Kael@live`, while `anna@example.com` is untouched; and a later sibling with the same name is
 * addressed by `~` and the start of its uuid, so a name ending in `~` and four or more hex digits in either case (`Kael~b21c`, `Kael~B21C`) has that `~` turned into `～`.
 *
 * FROZEN as the project tree's replay uses it (the list stores what was typed and every client
 * replays it through this): a change to what it returns for any input changes how old history
 * replays, and needs a migration of the list.
 */
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
    // The codec refuses a name with no stem (`.md`) and one that would show as another type;
    // the second stays as typed.
    if (parsed.ok) name = renderFilename(parsed.value.name, parsed.value.extension);
    else if (parsed.error.message.startsWith("A document name")) name = "";
  }
  return (name || UNTITLED)
    .replace(/@(?=(?:live|draft|[wcbp]\d+)$)/i, LOOK_ALIKE["@"] as string)
    .replace(SEGMENT_SUFFIX, (suffix) => (LOOK_ALIKE["~"] as string) + suffix.slice(1));
}

/** A segment of a path or a name: the same name as `normalEntryName`, empty when nothing was typed. */
export function validateContextEntryName(raw: string): ContextEntryValidationResult {
  if (!raw.trim()) return { ok: false, reason: "name/empty" };
  return { ok: true, value: normalEntryName("folder", raw) };
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

  // A twin's `~id` is address syntax: only the name in front of it is a name.
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
