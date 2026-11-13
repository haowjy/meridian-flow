/**
 * What a model can take as media and how each wire format carries it. Provider facts are in
 * `findings/provider-media-support.md` of the gateway-and-media work item.
 *
 * Two levels, because they change independently: the model says which kinds it takes
 * (`inputModalities`, copied from models.dev) and how large a file its provider fetches by link
 * (`maxLinkBytes`); the wire format says whether a link works per kind and where a tool result's
 * media goes. Two models of one provider can differ by wire (OpenAI Chat against Responses).
 * Placement is looked up by model, not wire alone: the Gemini wire keys it on the model's major
 * version (nested `functionResponse` parts need Gemini 3), and an OpenAI-compatible host may or
 * may not fetch image links.
 */
import type { BuiltinAdapter, MediaPart, ModelInfo } from "./types.js";

export type MediaKind = "image" | "pdf";

/**
 * What one PDF page costs a model, text and page image together: Anthropic measured 1,832 tokens
 * a page for short pages, and its docs give 1,500 to 3,000. The one figure for deciding whether a
 * PDF fits (`placeMedia`) and for pricing one in a context estimate.
 */
export const PDF_PAGE_TOKENS = 2_000;

/** The share of a model's context window a PDF may take as media, so the conversation still fits around it. */
const PDF_CONTEXT_SHARE = 0.5;

/** Anthropic takes 600 pages a request, 100 when the context window is under 1M tokens. */
const ANTHROPIC_PDF_PAGES = { large: 600, small: 100, largeWindowTokens: 1_000_000 };

interface WireMedia {
  /** The pages one request may carry, where the provider documents a cap; token fit applies to every wire. */
  pdfPageCap?: (model: Pick<ModelInfo, "contextWindow">) => number;
  /** Whether the provider fetches a link for this kind; otherwise it takes bytes only. */
  link: Record<MediaKind, boolean>;
  /** The image types the wire accepts, from each provider's docs. */
  imageTypes: readonly string[];
  /** The image types the wire accepts inside a tool result, when narrower than `imageTypes`. */
  toolResultImageTypes?: readonly string[];
  /**
   * `inside`: in the tool result itself. `after`: in a user message right after the tool results.
   * `none`: the model can't take media in a tool result.
   */
  toolResult: (model: Pick<ModelInfo, "id">) => "inside" | "after" | "none";
}

const OPENAI_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const WIRES: Record<BuiltinAdapter, WireMedia> = {
  anthropic: {
    pdfPageCap: (model) =>
      model.contextWindow >= ANTHROPIC_PDF_PAGES.largeWindowTokens
        ? ANTHROPIC_PDF_PAGES.large
        : ANTHROPIC_PDF_PAGES.small,
    link: { image: true, pdf: true },
    imageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    toolResult: () => "inside",
  },
  openai: {
    link: { image: true, pdf: true },
    imageTypes: OPENAI_IMAGE_TYPES,
    toolResult: () => "inside",
  },
  // Chat Completions has no file URL on a `file` part, so a PDF is bytes only; whether a host
  // fetches image links is its own fact (`ModelInfo.imageLinks`).
  "openai-compatible": {
    link: { image: false, pdf: false },
    imageTypes: OPENAI_IMAGE_TYPES,
    toolResult: () => "after",
  },
  // `functionResponse.parts` needs Gemini 3; an older or unknown model can't take media there.
  gemini: {
    link: { image: true, pdf: true },
    imageTypes: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
    // Google lists only these inside a function response.
    toolResultImageTypes: ["image/png", "image/jpeg", "image/webp"],
    toolResult: (model) => ((geminiMajorVersion(model.id) ?? 0) >= 3 ? "inside" : "none"),
  },
};

/** The major version in a Gemini model id (`gemini-3.1-flash-lite` is 3), or null for an id that doesn't say. */
export function geminiMajorVersion(modelId: string): number | null {
  const match = /^gemini-(\d+)(?:[.-]|$)/.exec(modelId);
  return match ? Number(match[1]) : null;
}

export function mediaKind(mediaType: string): MediaKind | null {
  if (mediaType.startsWith("image/")) return "image";
  return mediaType === "application/pdf" ? "pdf" : null;
}

type MediaModel = Pick<ModelInfo, "wire" | "imageLinks">;

function linksWork(model: MediaModel, kind: MediaKind): boolean {
  return WIRES[model.wire].link[kind] || (kind === "image" && model.imageLinks === true);
}

/** Whether the wire accepts this file type at all (an image type outside its table is refused). */
function wireAccepts(wire: BuiltinAdapter, kind: MediaKind, mediaType: string): boolean {
  return kind === "pdf" || WIRES[wire].imageTypes.includes(mediaType);
}

/** Whether a PDF of this many pages fits the model as media: under the provider's page cap and a share of its window. */
function pdfFits(model: Pick<ModelInfo, "wire" | "contextWindow">, pages: number): boolean {
  const cap = WIRES[model.wire].pdfPageCap?.(model) ?? Number.POSITIVE_INFINITY;
  return pages <= cap && pages * PDF_PAGE_TOKENS <= model.contextWindow * PDF_CONTEXT_SHARE;
}

export type MediaPlacement =
  | { transport: "link" | "bytes"; toolResult: "inside" | "after" | "none" }
  | { transport: "none" };

/**
 * How to send a file of this type (and size, when known) to this model: as a link, as bytes, or
 * not at all. `none` covers a kind the model doesn't take, an image type its wire doesn't
 * accept (the caller can send a preview instead), a file over the provider's link limit, a PDF
 * (when its `pages` are known) too long for the model's page cap or context window, and,
 * when `inToolResult` is set, a model that takes no media in a tool result; the caller then
 * describes the file in text. The wire decides whether a link works, so this never answers
 * `bytes` for a file a link could carry. `toolResult` says where a tool result's media go
 * (`none`: nowhere, for a model that takes media only in a user message).
 */
export function placeMedia(
  model: Pick<
    ModelInfo,
    "id" | "wire" | "inputModalities" | "maxLinkBytes" | "imageLinks" | "contextWindow"
  >,
  media: { mediaType: string; sizeBytes?: number; pages?: number; inToolResult?: true },
): MediaPlacement {
  const kind = mediaKind(media.mediaType);
  if (kind === null || !model.inputModalities.includes(kind)) return { transport: "none" };
  if (!wireAccepts(model.wire, kind, media.mediaType)) return { transport: "none" };
  if (kind === "pdf" && media.pages !== undefined && !pdfFits(model, media.pages))
    return { transport: "none" };
  const inToolResultTypes = WIRES[model.wire].toolResultImageTypes;
  if (
    media.inToolResult &&
    kind === "image" &&
    inToolResultTypes?.includes(media.mediaType) === false
  )
    return { transport: "none" };
  const toolResult = WIRES[model.wire].toolResult(model);
  if (toolResult === "none" && media.inToolResult) return { transport: "none" };
  if (!linksWork(model, kind)) return { transport: "bytes", toolResult };
  const { maxLinkBytes } = model;
  if (maxLinkBytes !== undefined && media.sizeBytes !== undefined && media.sizeBytes > maxLinkBytes)
    return { transport: "none" };
  return { transport: "link", toolResult };
}

export type WireMediaSource =
  | { kind: MediaKind; url: string }
  | { kind: MediaKind; data: string; mediaType: string; filename?: string };

/**
 * The part as a wire can carry it, or an error: a mapper never downloads a link, so a source
 * the wire can't take stops the request. A PDF sent as bytes always has a filename (OpenAI
 * requires one); one sent by link needs none.
 */
export function wireMediaSource(model: MediaModel, part: MediaPart): WireMediaSource {
  const kind = mediaKind(part.mediaType);
  if (kind === null || !wireAccepts(model.wire, kind, part.mediaType)) {
    throw new Error(`${model.wire} cannot carry media of type ${part.mediaType}`);
  }
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
  if (!linksWork(model, kind)) {
    throw new Error(`${model.wire} takes ${kind} media as bytes only, not by link`);
  }
  return { kind, url: source.url };
}
