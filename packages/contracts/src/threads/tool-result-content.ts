export type StoredMediaPart = {
  type: "media";
  ref: { documentId: string; uri: string };
  mediaType: string;
  sizeBytes: number;
  pageCount?: number;
  name: string;
  chatCopy?: { key: string };
};

export type StoredTextPart = { type: "text"; text: string };

export type ToolContentPart = StoredTextPart | StoredMediaPart;

export function toolContentPartText(part: ToolContentPart): string {
  return part.type === "text"
    ? part.text
    : `[${part.name}: ${part.mediaType}, ${part.sizeBytes} bytes]`;
}

export function toolContentText(parts: readonly ToolContentPart[]): string {
  return parts.map(toolContentPartText).join("\n");
}
