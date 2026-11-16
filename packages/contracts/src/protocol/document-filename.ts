/** The input codec for document basenames. Stored parts are the canonical name. */

import { agentsLocationOf } from "../agents/location.js";
import type { ContextUriScheme } from "../context-uri.js";
import { readSegment, withSegmentName } from "./entry-segment.js";
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
  if (filetypeForExtension(suffix)) {
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

/**
 * The name parts a document gets when created at `path`, the full source-relative path. The
 * location chooses the kind: a file in an Agents location is code text that keeps its suffix
 * (`agents/critic.md`, `mars.toml`), because Mars reads those bytes. Anywhere else the name codec
 * decides. Later naming follows the stored kind (`storedFilename`).
 */
export function documentFilenameAt(
  scheme: ContextUriScheme,
  path: string,
  options: { sourceExtension?: string } = {},
): DocumentFilenameResult {
  const leaf = readSegment(path.slice(path.lastIndexOf("/") + 1)).name;
  const location = agentsLocationOf(scheme, path);
  if (!location || location.path === "") return parseDocumentFilename(leaf, options);
  const input = leaf.trim();
  const dot = input.lastIndexOf(".");
  const name = dot > 0 ? input.slice(0, dot) : input;
  if (!name || name === "." || name === "..") {
    return {
      ok: false,
      error: { code: "invalid_name", message: "A document name must have a nonempty stem" },
    };
  }
  return {
    ok: true,
    value: { name, extension: dot > 0 ? input.slice(dot + 1) : "", filetype: "source" },
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

const SUFFIX_BEFORE_EXTENSION = /~([0-9a-f]{4,})\.([^.~]+)$/i;

/**
 * The canonical spelling of a leaf (`ch1.md` is `ch1`, `Kael.md~b21c` is `Kael~b21c`); a name the
 * codec refuses stays literal. A suffix written before a registered extension goes to the end,
 * where the segment has it (`data~3ec0.json` is `data.json~3ec0`).
 */
export function canonicalLeaf(leaf: string): string {
  const misplaced = SUFFIX_BEFORE_EXTENSION.exec(leaf);
  const spelled =
    misplaced && filetypeForExtension(misplaced[2] as string)
      ? `${leaf.slice(0, misplaced.index)}.${misplaced[2]}~${misplaced[1]}`
      : leaf;
  return withSegmentName(spelled, (filename) => {
    const parsed = parseDocumentFilename(filename);
    return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : filename;
  });
}

/** What a row says about its own name: its stored extension and whether it is a tracked document. */
export interface NamedRow {
  extension: string;
  editable: boolean;
  /** The row's kind when known: a `source` document keeps its name literally, as a kept file does. */
  filetype?: string | null;
}

export type StoredFilenameResult =
  | {
      ok: true;
      name: string;
      filename: { name: string; extension: string; filetype: Filetype | null };
    }
  | { ok: false; message: string; error: { code: "invalid_name"; message: string } };

function invalidName(message: string): StoredFilenameResult {
  return { ok: false, message, error: { code: "invalid_name", message } };
}

/**
 * Destination naming shared by optimistic clients and server commands, chosen by the row's
 * kind and never by its suffix: a stored file keeps its name literally (`fileName`), a tracked
 * document follows the document rules. No row is a create. `filetype` null keeps the file's type.
 */
export function storedFilename(typed: string, row?: NamedRow): StoredFilenameResult {
  if (row && (!row.editable || row.filetype === "source")) return fileName(typed, row);
  const parsed = parseDocumentFilename(typed, { sourceExtension: row?.extension });
  return parsed.ok
    ? {
        ok: true,
        name: renderFilename(parsed.value.name, parsed.value.extension),
        filename: parsed.value,
      }
    : invalidName(parsed.error.message);
}

/**
 * A stored file's name (bytes in object storage, or a file kept under a prose suffix such as
 * `binary.md`): literal, never an alias. A typed registered suffix states the extension, the
 * file's own suffix counts even unregistered, and any other name inherits the row's extension.
 * `filetype` is null while the extension is the row's, so the file keeps its type; any other
 * registered suffix names the type it would convert to, which the mover then refuses or accepts.
 * A kept prose file refuses a different prose suffix here, so the writer sees it at once.
 * The row's extension is compared lowercase and kept as stored.
 */
function fileName(typed: string, row: NamedRow): StoredFilenameResult {
  const input = typed.trim();
  const dot = input.lastIndexOf(".");
  const suffix = dot >= 0 ? input.slice(dot + 1).toLowerCase() : "";
  const stored = row.extension;
  const own = stored.toLowerCase();
  const ownSuffix = Boolean(suffix) && suffix === own;
  if (PROSE_EXTENSIONS.has(own) && PROSE_EXTENSIONS.has(suffix) && !ownSuffix)
    return invalidName(
      `a kept file keeps its \`.${own}\` suffix; \`.${suffix}\` would not convert it`,
    );
  const explicit = ownSuffix || Boolean(filetypeForExtension(suffix));
  const name = explicit ? input.slice(0, dot).trim() : input;
  if (!name || name === "." || name === "..")
    return invalidName("A document name must have a nonempty stem other than . or ..");
  const extension = ownSuffix ? stored : explicit ? suffix : stored;
  return {
    ok: true,
    name: renderFilename(name, extension),
    filename: {
      name,
      extension,
      filetype: extension.toLowerCase() === own ? null : (filetypeForExtension(extension) ?? null),
    },
  };
}

/**
 * The name a copy of a stored file gets: a prose suffix other than the row's own is only a name
 * (a PNG copied to `x.md` is `x.png`), and a kept prose file never converts.
 */
export function copiedFilename(typed: string, row: NamedRow): StoredFilenameResult {
  const input = typed.trim();
  const dot = input.lastIndexOf(".");
  const suffix = dot >= 0 ? input.slice(dot + 1).toLowerCase() : "";
  const bare =
    PROSE_EXTENSIONS.has(suffix) && suffix !== row.extension.toLowerCase()
      ? input.slice(0, dot)
      : input;
  return fileName(bare, row);
}

/** Every (name, extension) pair that renders as `filename`: lookups stay exact and indexed. */
export function filenameSplits(filename: string): { name: string; extension: string }[] {
  const splits = [{ name: filename, extension: "" }];
  for (let at = 1; at < filename.length - 1; at += 1) {
    if (filename[at] === ".") {
      splits.push({ name: filename.slice(0, at), extension: filename.slice(at + 1) });
    }
  }
  return splits;
}

/**
 * The parts a stored row renders as `filename`: its own `extension`, compared case-insensitively
 * and cut off with the spelling the filename has; a row with no extension is all name.
 */
export function splitRendered(
  filename: string,
  extension: string,
): { name: string; extension: string } {
  const at = filename.length - extension.length - 1;
  return extension && at > 0 && filename.slice(at).toLowerCase() === `.${extension.toLowerCase()}`
    ? { name: filename.slice(0, at), extension: filename.slice(at + 1) }
    : { name: filename, extension: "" };
}

/**
 * The spellings a tree lookup tries for a path's leaf, in order: as written (a file kept as
 * `binary.md` has that exact name), then the codec's alias (`ch1.md` is `ch1`).
 */
export function addressCandidates(leaf: string): string[] {
  const alias = canonicalLeaf(leaf);
  return alias === leaf ? [leaf] : [leaf, alias];
}
