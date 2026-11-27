import type { ContextReadResponse } from "@meridian/contracts/protocol";
import type { ServerOpenDocument } from "@/client/stores";

export type PreviewKind = "text" | "markdown" | "pdf" | "image" | "binary";

export function previewKind(tab: ServerOpenDocument, read: ContextReadResponse): PreviewKind {
  if (read.kind === "tracked") return read.filetype === "markdown" ? "markdown" : "text";
  const fileType = tab.kind === "viewer" ? tab.fileType : null;
  if (fileType === "image") return "image";
  if (read.mimeType === "text/markdown") return "markdown";
  if (fileType === "pdf") return "pdf";
  // `[/+-]` anchors the suffix: a bare /xml/ also matches the Word MIME type
  // (`…openxmlformats-officedocument…`), which would show a DOCX's zip bytes as text.
  // An HTML page is a file, not prose: its tags would read as the text.
  if (
    read.mimeType !== "text/html" &&
    (read.mimeType.startsWith("text/") || /[/+-](?:json|xml|yaml)$/i.test(read.mimeType))
  ) {
    return "text";
  }
  return "binary";
}
