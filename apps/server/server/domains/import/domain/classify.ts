/** The shared intake classifier for imported files. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import { classifyUpload, intakeFilename, sniffMime } from "../../file-intake/index.js";
export async function classify(filename: string, sniff: Uint8Array) {
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
  const mimeType = (await sniffMime(sniff)) ?? "application/octet-stream";
  const filetype = await classifyUpload({ filename, mimeType, bytes: sniff });
  const parsed = intakeFilename(filename, filetype, mimeType);
  if (!parsed.ok) throw new RangeError("Invalid import filename");
  const tracked = classifyFiletype(filetype);
  const kind =
    tracked.kind === "tracked" ? (tracked.schemaType === "code" ? "code" : "note") : "binary";
  return { ...parsed.value, kind, filetype, mimeType } as const;
}
