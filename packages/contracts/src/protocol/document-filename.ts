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

/**
 * A tracked document's name rules. A registered suffix is explicit; otherwise a destination
 * inherits its source extension. A prose suffix is an alias for the bare name (`ch1.md` is
 * `ch1`). A stored file's name is `fileName`'s, chosen by the row's kind.
 */
export function parseDocumentFilename(
  filename: string,
  options: { sourceExtension?: string } = {},
): DocumentFilenameResult {
  const input = filename.trim();
  let name = input;
  let extension = "";
  const dot = input.lastIndexOf(".");
  const suffix = dot >= 0 ? input.slice(dot + 1).toLowerCase() : "";
  const sourceExtension = options.sourceExtension?.toLowerCase() ?? "";
  // The source's own suffix is explicit even unregistered: `page.html` kept as a file stays one `.html`.
  if (filetypeForExtension(suffix) || (suffix && suffix === sourceExtension)) {
    name = input.slice(0, dot).trim();
    extension = suffix;
  } else extension = sourceExtension;
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
export function filenameForBinary<
  T extends { name: string; extension: string; filetype?: Filetype | null },
>(parsed: T, filetype: string, mimeType?: string): T {
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

/** What a row says about its own name: its stored extension and whether it is a stored file. */
export interface NamedRow {
  extension: string;
  stored: boolean;
}

export type StoredFilenameResult =
  | {
      ok: true;
      name: string;
      filename: { name: string; extension: string; filetype: Filetype | null };
    }
  | { ok: false; message: string; error: { code: "invalid_name"; message: string } };

/**
 * Destination naming shared by optimistic clients and server commands, chosen by the row's
 * kind and never by its suffix: a stored file keeps its name literally (`fileName`), a tracked
 * document follows the document rules. No row is a create. `filetype` null keeps the file's type.
 */
export function storedFilename(typed: string, row?: NamedRow): StoredFilenameResult {
  const parsed = row?.stored
    ? fileName(typed, row)
    : parseDocumentFilename(typed, { sourceExtension: row?.extension });
  return parsed.ok
    ? {
        ok: true,
        name: renderFilename(parsed.value.name, parsed.value.extension),
        filename: parsed.value,
      }
    : { ok: false, message: parsed.error.message, error: parsed.error };
}

export type StoredFileNameResult =
  | { ok: true; value: { name: string; extension: string; filetype: Filetype | null } }
  | { ok: false; error: { code: "invalid_name"; message: string } };

/**
 * A stored file's name (bytes in object storage, or a file kept under a prose suffix such as
 * `binary.md`): literal, never an alias. A typed registered suffix states the extension, the
 * file's own suffix counts even unregistered, and any other name inherits the row's extension.
 * `filetype` is null while the extension is the row's, so the file keeps its type; any other
 * registered suffix names the type it would convert to, which the mover then refuses or accepts.
 */
export function fileName(typed: string, row: { extension: string }): StoredFileNameResult {
  const input = typed.trim();
  const dot = input.lastIndexOf(".");
  const suffix = dot >= 0 ? input.slice(dot + 1).toLowerCase() : "";
  const explicit = Boolean(filetypeForExtension(suffix) || (suffix && suffix === row.extension));
  const name = explicit ? input.slice(0, dot).trim() : input;
  const extension = explicit ? suffix : row.extension;
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
    value: {
      name,
      extension,
      filetype: extension === row.extension ? null : (filetypeForExtension(extension) ?? null),
    },
  };
}

/** One spelling a lookup tries; `extensionOmitted` matches a row whose own extension is dropped. */
export interface AddressCandidate {
  leaf: string;
  extensionOmitted: boolean;
}

/**
 * The spellings a lookup tries for a path's leaf, in order: as written (a file kept as
 * `binary.md` has that exact name), the codec's alias (`ch1.md` is `ch1`), then the alias
 * against rows that carry an extension the writer left off.
 */
export function addressCandidates(leaf: string): AddressCandidate[] {
  const parsed = parseDocumentFilename(leaf);
  const alias = parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : leaf;
  return [
    { leaf, extensionOmitted: false },
    ...(alias === leaf ? [] : [{ leaf: alias, extensionOmitted: false }]),
    { leaf: alias, extensionOmitted: true },
  ];
}
