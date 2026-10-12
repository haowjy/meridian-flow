/** Selection skip rules and the shared intake classifier. */
import type { ImportSkipReason } from "@meridian/contracts";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { classifyUpload, intakeFilename, sniffMime } from "../../file-intake/index.js";
export function skipPath(path: string): "omit" | ImportSkipReason | null {
  const segments = path.split("/");
  if (
    segments[0] === ".obsidian" ||
    segments[0] === ".git" ||
    path === "meridian-export.json" ||
    segments.some((value) => [".DS_Store", "Thumbs.db", "desktop.ini"].includes(value))
  )
    return "omit";
  if (segments.some((value) => value.startsWith(".")))
    return segments[0] === ".trash" ? "trash" : "hidden";
  if (/\.(canvas|base)$/i.test(path)) return "obsidian_canvas";
  return null;
}
export function classify(filename: string, sniff: Uint8Array) {
  if (/\.docx$/i.test(filename)) {
    const name = filename.slice(0, -5);
    return {
      kind: "docx" as const,
      filetype: "markdown" as const,
      name,
      extension: "",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  const mimeType = sniffMime(sniff) ?? "application/octet-stream";
  const filetype = classifyUpload({ filename, mimeType, bytes: sniff });
  const parsed = intakeFilename(filename, filetype, mimeType);
  if (!parsed.ok) throw new RangeError("Invalid import filename");
  const tracked = classifyFiletype(filetype);
  const kind =
    tracked.kind === "tracked" ? (tracked.schemaType === "code" ? "code" : "note") : "binary";
  return { ...parsed.value, kind, filetype, mimeType } as const;
}
