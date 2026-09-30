/** Chooses the read-only preview surface from stored tab classification and read data. */
import type { ContextReadResponse } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";

export type PreviewKind = "text" | "markdown" | "pdf" | "image" | "binary";

export function previewKind(
  tab: Extract<ContextTab, { kind: "viewer" }>,
  read: ContextReadResponse,
): PreviewKind {
  if (read.kind === "tracked") {
    return tab.name.toLowerCase().endsWith(".md") ? "markdown" : "text";
  }
  if (tab.fileType === "image") return "image";
  if (tab.name.toLowerCase().endsWith(".md")) return "markdown";
  if (tab.fileType === "pdf") return "pdf";
  if (read.mimeType.startsWith("text/") || /(?:json|xml|yaml)/i.test(read.mimeType)) {
    return "text";
  }
  return "binary";
}
