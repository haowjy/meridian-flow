/**
 * Purpose: The parts of a stored tool result's `content`: what the model saw, frozen when stored.
 * Key decision: a stored media part is a durable reference, never bytes or a link; the request
 * builder resolves it when it maps the part to the gateway's.
 */

// Type aliases, not interfaces: a block's `content` is JSON, and only an alias is assignable to it.
export type StoredMediaPart = {
  type: "media";
  ref: { documentId: string; uri: string };
  mediaType: string;
  sizeBytes: number;
  /** A PDF's page count, counted when it was read; what it costs the model depends on it. */
  pageCount?: number;
  name: string;
};

export type StoredTextPart = { type: "text"; text: string };

export type ToolContentPart = StoredTextPart | StoredMediaPart;

/** A part as text: its text, or a media part's name, type and size. */
export function toolContentPartText(part: ToolContentPart): string {
  return part.type === "text"
    ? part.text
    : `[${part.name}: ${part.mediaType}, ${part.sizeBytes} bytes]`;
}

/** The parts as one text, for readers that carry text only (history, transcripts, the AG-UI stream). */
export function toolContentText(parts: readonly ToolContentPart[]): string {
  return parts.map(toolContentPartText).join("\n");
}
