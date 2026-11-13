/**
 * What a model can take as media and how each wire format carries it. Provider facts are in
 * `findings/provider-media-support.md` of the gateway-and-media work item.
 *
 * Two levels, because they change independently: the model says which kinds it takes
 * (`inputModalities`, copied from models.dev) and how large a file its provider fetches by link
 * (`maxLinkBytes`); the wire format says whether a link works per kind and where a tool result's
 * media goes. Two models of one provider can differ by wire (OpenAI Chat against Responses).
 * Placement is looked up by model, not wire alone, so a Gemini adapter can key it on the model's
 * major version (nested `functionResponse` parts need Gemini 3).
 */
import type { BuiltinAdapter, MediaPart, ModelInfo } from "./types.js";

export type MediaKind = "image" | "pdf";

interface WireMedia {
  /** Whether the provider fetches a link for this kind; otherwise it takes bytes only. */
  link: Record<MediaKind, boolean>;
  /** `inside`: in the tool result itself. `after`: in a user message right after the tool results. */
  toolResult: "inside" | "after";
}

const WIRES: Record<BuiltinAdapter, WireMedia> = {
  anthropic: { link: { image: true, pdf: true }, toolResult: "inside" },
  openai: { link: { image: true, pdf: true }, toolResult: "inside" },
  // Chat Completions has no file URL on a `file` part, so a PDF is bytes only.
  "openai-compatible": { link: { image: true, pdf: false }, toolResult: "after" },
};

export function mediaKind(mediaType: string): MediaKind | null {
  if (mediaType.startsWith("image/")) return "image";
  return mediaType === "application/pdf" ? "pdf" : null;
}

export type MediaPlacement =
  | { transport: "link" | "bytes"; toolResult: "inside" | "after" }
  | { transport: "none" };

/**
 * How to send a file of this type (and size, when known) to this model: as a link, as bytes, or
 * not at all. `none` covers a kind the model doesn't take and a file over the provider's link
 * limit, where the caller describes the file in text instead. The wire decides whether a link
 * works, so this never answers `bytes` for a file a link could carry.
 */
export function placeMedia(
  model: Pick<ModelInfo, "wire" | "inputModalities" | "maxLinkBytes">,
  media: { mediaType: string; sizeBytes?: number },
): MediaPlacement {
  const kind = mediaKind(media.mediaType);
  if (kind === null || !model.inputModalities.includes(kind)) return { transport: "none" };
  const wire = WIRES[model.wire];
  if (!wire.link[kind]) return { transport: "bytes", toolResult: wire.toolResult };
  const { maxLinkBytes } = model;
  if (maxLinkBytes !== undefined && media.sizeBytes !== undefined && media.sizeBytes > maxLinkBytes)
    return { transport: "none" };
  return { transport: "link", toolResult: wire.toolResult };
}

export function mediaToolResultPlacement(model: Pick<ModelInfo, "wire">): "inside" | "after" {
  return WIRES[model.wire].toolResult;
}

export type WireMediaSource =
  | { kind: MediaKind; url: string }
  | { kind: MediaKind; data: string; mediaType: string; filename?: string };

/**
 * The part as a wire can carry it, or an error: a mapper never downloads a link, so a source
 * the wire can't take stops the request. A PDF sent as bytes always has a filename (OpenAI
 * requires one); one sent by link needs none.
 */
export function wireMediaSource(model: Pick<ModelInfo, "wire">, part: MediaPart): WireMediaSource {
  const kind = mediaKind(part.mediaType);
  if (kind === null) throw new Error(`${model.wire} cannot carry media of type ${part.mediaType}`);
  const { source } = part;
  if ("reference" in source) {
    throw new Error(
      `${model.wire} does not send provider file references (${source.reference.provider})`,
    );
  }
  if ("data" in source) {
    return {
      kind,
      data: source.data,
      mediaType: part.mediaType,
      ...(kind === "pdf" ? { filename: part.filename ?? "document.pdf" } : {}),
    };
  }
  if (!source.url.startsWith("https://")) {
    throw new Error("A media link must be an https URL; send bytes in `data`, not a data URL");
  }
  if (!WIRES[model.wire].link[kind]) {
    throw new Error(`${model.wire} takes ${kind} media as bytes only, not by link`);
  }
  return { kind, url: source.url };
}
