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
  let keptAsFile =
    html ||
    (asText && !isUtf8(bytes)) ||
    (!asText && !sniffed && declared !== null && classifyFiletype(declared).kind === "tracked");
  if (keptAsFile && asText) filetype = "binary";
  let parsed = intakeFilename(filename, filetype, mimeType);
  if (!parsed.ok) {
    keptAsFile = true;
    filetype = "binary";
    parsed = { ok: true, value: { name: filename, extension: "", filetype: "binary" } };
  }
  const tracked = classifyFiletype(filetype);
  const kind =
    tracked.kind === "tracked" ? (tracked.schemaType === "code" ? "code" : "note") : "binary";
  const dot = filename.lastIndexOf(".");
  const named =
    keptAsFile && !parsed.value.extension && dot > 0 && !/\s/.test(filename.slice(dot + 1))
      ? { name: filename.slice(0, dot), extension: filename.slice(dot + 1) }
      : {};
  return { keptAsFile, facts: { ...parsed.value, ...named, kind, filetype, mimeType } as const };
}
