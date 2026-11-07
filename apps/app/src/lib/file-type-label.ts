/** The writer's word for a stored file's type: "PDF", "TIFF image", or "" when nothing says. */
export function fileTypeLabel(name: string, mimeType: string): string {
  const [kind, subtype = ""] = mimeType.split("/");
  const extension = name.includes(".") ? name.split(".").pop() : undefined;
  const format = (extension || subtype.replace(/^x-|\+.*$/g, "")).toUpperCase();
  if (!format || mimeType === "application/octet-stream") return extension?.toUpperCase() ?? "";
  return kind === "image" ? `${format} image` : format;
}
