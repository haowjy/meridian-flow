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

export function renderFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}

export function splitExtension(filename: string): { name: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1 && !/\s/.test(filename.slice(dot + 1))
    ? { name: filename.slice(0, dot), extension: filename.slice(dot + 1) }
    : { name: filename, extension: "" };
}

export function entryExtension(entry: {
  kind: "folder" | "document" | "file";
  name: string;
  filetype?: string | null;
}): string {
  if (entry.kind === "folder") return "";
  if (entry.kind === "file" || entry.filetype === "source")
    return splitExtension(entry.name).extension.toLowerCase();
  const parsed = parseDocumentFilename(entry.name);
  return parsed.ok ? parsed.value.extension : "";
}

export function numberedName(entry: string, n: number, kind: "file" | "folder"): string {
  if (n === 1) return entry;
  if (kind === "folder") return `${entry} (${n})`;
  const { name, extension } = splitExtension(entry);
  return renderFilename(`${name} (${n})`, extension);
}

const SUFFIX_BEFORE_EXTENSION = /~([0-9a-f]{4,})\.([^.~]+)$/i;

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

export interface NamedRow {
  extension: string;
  editable: boolean;
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

export function filenameSplits(filename: string): { name: string; extension: string }[] {
  const splits = [{ name: filename, extension: "" }];
  for (let at = 1; at < filename.length - 1; at += 1) {
    if (filename[at] === ".") {
      splits.push({ name: filename.slice(0, at), extension: filename.slice(at + 1) });
    }
  }
  return splits;
}

export function splitRendered(
  filename: string,
  extension: string,
): { name: string; extension: string } {
  const at = filename.length - extension.length - 1;
  return extension && at > 0 && filename.slice(at).toLowerCase() === `.${extension.toLowerCase()}`
    ? { name: filename.slice(0, at), extension: filename.slice(at + 1) }
    : { name: filename, extension: "" };
}

export function addressCandidates(leaf: string): string[] {
  const alias = canonicalLeaf(leaf);
  return alias === leaf ? [leaf] : [leaf, alias];
}
