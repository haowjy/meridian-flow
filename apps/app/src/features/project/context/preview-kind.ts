/** Chooses the read-only preview surface from stored tab classification and read data. */
import type { ContextReadResponse } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";

export type PreviewKind = "text" | "markdown" | "pdf" | "image" | "binary";

export function previewKind(
  tab: Extract<ContextTab, { kind: "viewer" }>,
  read: ContextReadResponse,
): PreviewKind {
  // A name never says what a file is (`Chapter 13` has no suffix): the stored
  // classification and the read do.
  if (read.kind === "tracked") return read.filetype === "markdown" ? "markdown" : "text";
  if (tab.fileType === "image") return "image";
  if (read.mimeType === "text/markdown") return "markdown";
  if (tab.fileType === "pdf") return "pdf";
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
