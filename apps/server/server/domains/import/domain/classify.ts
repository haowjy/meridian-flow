/** The shared intake classifier for imported files. */
import {
  classifyFiletype,
  type Filetype,
  filetypeForKnownPath,
} from "@meridian/contracts/protocol";
import { classifyUpload, intakeFilename, sniffMime } from "../../file-intake/index.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Facts about a received file, and whether it is a document that could not become one. Such a
 * file stays in the project as a file (`kept_as_file`): a document extension over bytes that are
 * not text and not a known binary format (a real PDF named `.txt` is just a PDF), text that is
 * not valid UTF-8, or an HTML page (its tags are not prose).
 * `bytes` is the whole file at receipt; a DOCX's embedded images pass theirs too and are never kept.
 */
export async function classify(filename: string, bytes: Uint8Array) {
  if (/\.docx$/i.test(filename)) {
    const name = filename.slice(0, -5);
    return {
      keptAsFile: false,
      facts: {
        kind: "docx" as const,
        filetype: "markdown" as const,
        name,
        extension: "",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    };
  }
  const html = /\.html?$/i.test(filename);
  const sniffed = await sniffMime(bytes);
  const mimeType = html ? "text/html" : (sniffed ?? "application/octet-stream");
  let filetype: Filetype = html ? "binary" : await classifyUpload({ filename, mimeType, bytes });
  const asText = classifyFiletype(filetype).kind === "tracked";
  const declared = filetypeForKnownPath(filename);
  const keptAsFile =
    html ||
    (asText && !isUtf8(bytes)) ||
    (!asText && !sniffed && declared !== null && classifyFiletype(declared).kind === "tracked");
  if (keptAsFile && asText) filetype = "binary";
  const parsed = intakeFilename(filename, filetype, mimeType);
  if (!parsed.ok) throw new RangeError("Invalid import filename");
  const tracked = classifyFiletype(filetype);
  const kind =
    tracked.kind === "tracked" ? (tracked.schemaType === "code" ? "code" : "note") : "binary";
  // The file keeps its whole name, extension included, so Download gives back what was picked.
  const dot = filename.lastIndexOf(".");
  const named =
    keptAsFile && !parsed.value.extension && dot > 0
      ? { name: filename.slice(0, dot), extension: filename.slice(dot + 1) }
      : {};
  return { keptAsFile, facts: { ...parsed.value, ...named, kind, filetype, mimeType } as const };
}
