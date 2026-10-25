/** The input codec for document basenames. Stored parts are the canonical name. */
import {
  classifyFiletype,
  type Filetype,
  filetypeForExtension,
  filetypeForKnownMimeType,
  PROSE_EXTENSIONS,
  registeredExtensionForFiletype,
} from "./filetype.js";

export interface ParsedDocumentFilename {
  name: string;
  extension: string;
  filetype: Filetype;
}
export type DocumentFilenameResult =
  | { ok: true; value: ParsedDocumentFilename }
  | { ok: false; error: { code: "invalid_name"; message: string } };

/** A registered suffix is explicit; otherwise a destination inherits its source extension. */
export function parseDocumentFilename(
  filename: string,
  options: { sourceExtension?: string } = {},
): DocumentFilenameResult {
  const input = filename.trim();
  let name = input;
  let extension = "";
  const dot = input.lastIndexOf(".");
  const suffix = dot >= 0 ? input.slice(dot + 1).toLowerCase() : "";
  const typed = filetypeForExtension(suffix);
  if (typed) {
    name = input.slice(0, dot).trim();
    extension = suffix;
  } else extension = options.sourceExtension?.toLowerCase() ?? "";
  if (PROSE_EXTENSIONS.has(extension)) {
    extension = "";
    while (true) {
      const dot = name.lastIndexOf(".");
      if (dot < 0 || !PROSE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) break;
      name = name.slice(0, dot).trim();
    }
  }
  if (!extension) {
    const dot = name.lastIndexOf(".");
    const suffix = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (filetypeForExtension(suffix) && !PROSE_EXTENSIONS.has(suffix)) {
      return {
        ok: false,
        error: {
          code: "invalid_name",
          message: `\`${input}\` would show as \`${name}\`; name it \`${name}\` for a ${filetypeForExtension(suffix)} file, or drop \`.${suffix}\``,
        },
      };
    }
  }
  if (!name || name === "." || name === "..")
    return {
      ok: false,
      error: {
        code: "invalid_name",
        message: "A document name must have a nonempty stem other than . or ..",
      },
    };
  return {
    ok: true,
    value: { name, extension, filetype: filetypeForExtension(extension) ?? "markdown" },
  };
}

/** Binary storage chooses a registered suffix only when the parsed name is prose.
 * Identity parsing itself never depends on storage kind.
 */
export function filenameForBinary(
  parsed: ParsedDocumentFilename,
  filetype: string,
  mimeType?: string,
): ParsedDocumentFilename {
  if (parsed.extension) return parsed;
  const mimeFiletype = mimeType ? filetypeForKnownMimeType(mimeType) : null;
  const type =
    mimeFiletype && classifyFiletype(mimeFiletype).kind === "binary" ? mimeFiletype : filetype;
  const extension = registeredExtensionForFiletype(type);
  return extension
    ? { ...parsed, extension, filetype: filetypeForExtension(extension) ?? parsed.filetype }
    : parsed;
}

/** Canonical path segment from stored parts. */
export function renderFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}

/** Folder spelling stays literal, but valid document aliases cannot hide an opposite-kind claim. */
export function folderDocumentName(filename: string): string {
  const parsed = parseDocumentFilename(filename);
  return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : filename;
}

export type NamespaceNameClaim = {
  kind: "document" | "folder";
  filename: string;
};

/** The comparison name a node presents to a claim of the opposite kind. */
export function namespaceName(claim: NamespaceNameClaim): string {
  return claim.kind === "folder" ? folderDocumentName(claim.filename) : claim.filename;
}

/** The document row that could hold this namespace claim's document-facing alias. */
export function documentPartsForNamespaceClaim(
  claim: NamespaceNameClaim,
): Pick<ParsedDocumentFilename, "name" | "extension"> | null {
  const parsed = parseDocumentFilename(namespaceName(claim));
  return parsed.ok ? { name: parsed.value.name, extension: parsed.value.extension } : null;
}

/** Documents and folders share aliases, while nodes of the same kind compare literally. */
export function sameNamespaceName(left: NamespaceNameClaim, right: NamespaceNameClaim): boolean {
  return left.kind === right.kind
    ? left.filename === right.filename
    : namespaceName(left) === namespaceName(right);
}

type DesiredFilename =
  | { kind: "document"; name: string; extension: string }
  | { kind: "folder"; name: string };

/** The names an arrival tries in order: `name`, then `name (2)`, `name (3)`… from `startSuffix`. */
export function* filenameCandidates(
  desired: DesiredFilename,
  startSuffix = 1,
): Generator<NamespaceNameClaim, never> {
  for (let suffix = startSuffix; ; suffix += 1) {
    const base = suffix === 1 ? desired.name : `${desired.name} (${suffix})`;
    const filename = desired.kind === "document" ? renderFilename(base, desired.extension) : base;
    yield { kind: desired.kind, filename };
  }
}

/** Smallest available name at or after `startSuffix`. Callers own the atomic claim. */
export async function allocateFilename(
  desired: DesiredFilename,
  isTaken: (candidate: NamespaceNameClaim) => boolean | Promise<boolean>,
  startSuffix = 1,
): Promise<string> {
  for (const candidate of filenameCandidates(desired, startSuffix))
    if (!(await isTaken(candidate))) return candidate.filename;
  throw new Error("unreachable");
}

/** Destination naming shared by optimistic clients and server commands.
 * Explicit registered suffixes state the type; other names keep the source extension.
 * Parsed parts accompany the full name so storage never infers the destination twice.
 */
export function storedFilename(
  typed: string,
  current?: string | Pick<ParsedDocumentFilename, "extension">,
):
  | { ok: true; name: string; filename: ParsedDocumentFilename }
  | { ok: false; message: string; error: { code: "invalid_name"; message: string } } {
  const source = typeof current === "string" ? parseDocumentFilename(current) : null;
  const sourceExtension =
    typeof current === "object" ? current.extension : source?.ok ? source.value.extension : "";
  const parsed = parseDocumentFilename(typed, { sourceExtension });
  return parsed.ok
    ? {
        ok: true,
        name: renderFilename(parsed.value.name, parsed.value.extension),
        filename: parsed.value,
      }
    : { ok: false, message: parsed.error.message, error: parsed.error };
}
