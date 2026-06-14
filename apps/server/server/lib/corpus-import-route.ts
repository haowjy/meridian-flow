import type { CorpusImportInputFile } from "../domains/context/index.js";

type MultipartPart = {
  name?: string;
  filename?: string;
  type?: string;
  data: Uint8Array;
};

function cleanFilename(filename: string): string {
  const cleaned = filename.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  return cleaned || "import";
}

function cleanRelativePath(filename: string): string | undefined {
  const path = filename.replace(/\\/g, "/").trim();
  if (!path.includes("/")) return undefined;
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length > 1 ? segments.join("/") : undefined;
}

export function corpusFilesFromMultipart(
  parts: MultipartPart[] | undefined,
): CorpusImportInputFile[] {
  return (parts ?? [])
    .filter((part) => part.name === "files" && part.filename)
    .map((part) => ({
      filename: cleanFilename(part.filename ?? "import"),
      relativePath: cleanRelativePath(part.filename ?? ""),
      mimeType: part.type?.trim() ?? "",
      bytes: part.data,
    }));
}
