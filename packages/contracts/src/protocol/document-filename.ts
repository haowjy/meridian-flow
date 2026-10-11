/** The input codec for document basenames. Stored parts are the canonical name. */
import {
  classifyFiletype,
  type Filetype,
  filetypeForExtension,
  PROSE_EXTENSIONS,
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
  options: { sourceExtension?: string; binary?: boolean } = {},
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
  if (!options.binary && PROSE_EXTENSIONS.has(extension)) {
    extension = "";
    while (true) {
      const dot = name.lastIndexOf(".");
      if (dot < 0 || !PROSE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) break;
      name = name.slice(0, dot).trim();
    }
  }
  if (!options.binary && !extension) {
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

/** Storage-backed bytes retain registered suffixes without prose normalization. */
export function parseBinaryFilename(
  filename: string,
  options: { sourceExtension?: string } = {},
): DocumentFilenameResult {
  return parseDocumentFilename(filename, { ...options, binary: true });
}

/** Canonical path segment from stored parts. */
export function renderFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}

/**
 * The name a typed filename is stored under when it names (or renames) the file
 * currently called `current`: the typed suffix states the type, otherwise the
 * current file keeps its extension (`settings` on `config.toml` is
 * `settings.toml`; a prose document has none to keep). Clients submit this, so
 * their optimistic name and the server's answer are the same string.
 */
export function storedFilename(
  typed: string,
  current?: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const source = current ? parseDocumentFilename(current) : null;
  const sourceExtension = source?.ok ? source.value.extension : "";
  const binary =
    Boolean(sourceExtension) &&
    source?.ok === true &&
    classifyFiletype(source.value.filetype).kind === "binary";
  const parsed = parseDocumentFilename(typed, { sourceExtension, binary });
  return parsed.ok
    ? { ok: true, name: renderFilename(parsed.value.name, parsed.value.extension) }
    : { ok: false, message: parsed.error.message };
}
