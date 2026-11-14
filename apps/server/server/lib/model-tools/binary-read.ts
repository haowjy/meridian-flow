/**
 * `read` on a file that is not a tracked document. What the model is given is decided here,
 * once, at the call, and stored with the result: an image, or a PDF the model takes, as a media
 * part; a PDF it can't take, or an EPUB, as the text extracted from it (read like a document);
 * any other file as a description.
 */
import {
  type AgentEditResultV1,
  createAgentEditCodecFactory,
  formatDocumentFile,
  modelResult,
  type ReadToolInput,
  readStaticMarkdown,
  splitDocumentFile,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { type ModelInfo, placeMedia } from "@meridian-flow/gateway";
import type { BinaryFileRef } from "../../domains/context/index.js";
import { PREVIEW_MIME_TYPE } from "../../domains/file-intake/image-preview.js";
import { countPdfPages } from "../../domains/file-intake/text/convert.js";
import { extractedText, type TextSource } from "../../domains/file-intake/text/extracted-text.js";
import { CONVERSION_LIMITS, ConversionRefused } from "../../domains/file-intake/text/limits.js";
import { objectStoreKeyFromStorageUrl, previewObjectKey } from "../../domains/storage/index.js";
import { documentGrant } from "./file-access.js";
import { isToolError, type ToolCall, type ToolWiringDeps, writeToolError } from "./tool-context.js";

/**
 * Where what the model is given goes: in the tool result (the agent's own read) or in the user
 * message (a file the writer mentioned). Models differ in what they take in each place.
 */
export type ReadPlacement = "tool-result" | "user-message";

/**
 * Extracted text longer than this many characters (about 7,500 tokens) is read as its outline
 * first, unless the call names a section, a range, a search or a format.
 */
export const OUTLINE_FIRST_CHARS = 30_000;

const schema = buildDocumentSchema();
const staticReader = {
  model: yProsemirrorModel(schema),
  codec: createAgentEditCodecFactory(mdxCodec({ schema })),
  links: UNSCOPED_DOCUMENT_LINKS,
};

type FileFacts = Omit<NonNullable<AgentEditResultV1["file"]>, "given">;
type Given = NonNullable<AgentEditResultV1["file"]>["given"];

export async function readBinaryFile(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: ReadToolInput,
  model: ModelInfo | undefined,
  placement: ReadPlacement,
): Promise<{ output: AgentEditResultV1; revision: null; isError?: true }> {
  const { filePath, fragment } = splitDocumentFile(input.path);
  const found = await call.context.port.stat(filePath);
  if (!found.ok || found.value.kind !== "binary" || !found.value.documentId)
    return {
      ...writeToolError("read", "The file can't be read.", "document_not_found", {
        path: input.path,
      }),
      revision: null,
    };
  const ref = found.value;
  const address = { documentId: ref.documentId as string, filePath: ref.uri };
  const grant = await documentGrant(deps, call.principal, "read", address, "read");
  if (isToolError(grant)) return { ...grant, revision: null };
  if (input.format === "edits")
    return {
      ...writeToolError(
        "read",
        `${leaf(ref.uri)} isn't text, so it has no edits.`,
        "invalid_write",
        {
          path: ref.uri,
        },
      ),
      revision: null,
    };

  const file = {
    documentId: ref.documentId as string,
    uri: ref.uri,
    name: leaf(ref.uri),
    mediaType: ref.mimeType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream",
    sizeBytes: ref.sizeBytes ?? 0,
  };
  const describe = (reason: string): AgentEditResultV1 =>
    result(file, "description", {
      message: `${file.name} (${file.mediaType}, ${file.sizeBytes} bytes): ${reason}`,
    });

  const source = textSource(ref, file.mediaType);
  if (source === "epub")
    return {
      output: await text(deps, ref, file, input, fragment, "epub", describe),
      revision: null,
    };
  const where = placement === "tool-result" ? ({ inToolResult: true } as const) : {};
  if (file.mediaType === "application/pdf") {
    const pages = model
      ? await pdfMediaPages(deps, ref, file.mediaType, file.sizeBytes, model, where)
      : null;
    return done(
      pages !== null
        ? result({ ...file, pageCount: pages }, "media", {})
        : await text(deps, ref, file, input, fragment, "pdf", describe),
    );
  }
  if (file.mediaType.startsWith("image/")) {
    // An image type the models don't take goes as the preview the server made of it, whose own
    // size is the one a provider's link limit applies to.
    const previewKey = ref.hasPreview ? objectStoreKeyFromStorageUrl(ref.storageUrl) : null;
    const preview = previewKey
      ? await deps.objectStore.readHead(previewObjectKey(previewKey), 0)
      : null;
    const candidates = [
      { mediaType: file.mediaType, sizeBytes: file.sizeBytes },
      ...(preview?.ok
        ? [{ mediaType: PREVIEW_MIME_TYPE, sizeBytes: preview.value.sizeBytes }]
        : []),
    ];
    const viewable = candidates.some(
      (candidate) =>
        model !== undefined && placeMedia(model, { ...candidate, ...where }).transport !== "none",
    );
    return done(
      viewable ? result(file, "media", {}) : describe("this model can't view images of this kind."),
    );
  }
  return done(describe("this model can't read files of this type."));
}

/** A refusal is an error result; anything else the model was given. */
function done(output: AgentEditResultV1): {
  output: AgentEditResultV1;
  revision: null;
  isError?: true;
} {
  return {
    output,
    revision: null,
    ...(output.status === "success" ? {} : { isError: true as const }),
  };
}

/**
 * The page count of a PDF the model takes as media, or null when it goes as text instead: the
 * model doesn't take PDFs here, the PDF can't be opened (the text read says why), or it is too
 * long for the model.
 */
async function pdfMediaPages(
  deps: ToolWiringDeps,
  ref: BinaryFileRef,
  mediaType: string,
  sizeBytes: number,
  model: ModelInfo,
  where: { inToolResult?: true },
): Promise<number | null> {
  if (placeMedia(model, { mediaType, sizeBytes, ...where }).transport === "none") return null;
  const key = objectStoreKeyFromStorageUrl(ref.storageUrl);
  if (!key) return null;
  const original = await deps.objectStore.get(key, { maxBytes: CONVERSION_LIMITS.originalBytes });
  if (!original.ok) return null;
  const pages = await countPdfPages(original.value.bytes).catch((error: unknown) => {
    if (error instanceof ConversionRefused) return null;
    throw error;
  });
  if (pages === null) return null;
  return placeMedia(model, { mediaType, sizeBytes, pages, ...where }).transport === "none"
    ? null
    : pages;
}

function leaf(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

function textSource(ref: BinaryFileRef, mediaType: string): TextSource | null {
  return mediaType === "application/epub+zip" || ref.extension.toLowerCase() === "epub"
    ? "epub"
    : null;
}

function result(file: FileFacts, given: Given, payload: { message?: string }): AgentEditResultV1 {
  return modelResult({
    command: "read",
    status: "success",
    phase: "committed",
    payload: { path: file.uri, file: { ...file, given }, ...payload },
  });
}

/** The file's extracted text, read through the document renderer; a file with none is described. */
async function text(
  deps: ToolWiringDeps,
  ref: BinaryFileRef,
  file: FileFacts,
  input: ReadToolInput,
  fragment: string | undefined,
  source: TextSource,
  describe: (reason: string) => AgentEditResultV1,
): Promise<AgentEditResultV1> {
  const label = source === "pdf" ? "PDF" : "EPUB";
  const extracted = await extractedText(deps.objectStore, { storageUrl: ref.storageUrl, source });
  if (!extracted.ok) {
    if (extracted.reason === "hostile")
      return writeToolError(
        "read",
        `${file.name} was refused: ${extracted.message}`,
        "invalid_write",
        {
          path: file.uri,
        },
      ).output;
    if (extracted.reason === "too_large")
      return describe(`it can't be read as text: ${extracted.message}`);
    return describe(
      source === "pdf"
        ? `this model can't view PDFs and no text could be extracted: ${extracted.message}`
        : `no text could be extracted: ${extracted.message}`,
    );
  }
  const whole = input.in === undefined && input.around === undefined && !fragment && !input.format;
  const outlined = whole && extracted.markdown.length > OUTLINE_FIRST_CHARS;
  const read = readStaticMarkdown(staticReader, extracted.markdown, {
    file: formatDocumentFile({ filePath: file.uri, fragment }),
    documentId: file.documentId,
    ...(input.in !== undefined ? { in: input.in } : {}),
    ...(input.around !== undefined ? { around: input.around } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(outlined ? { format: "outline" as const } : {}),
  }).result;
  if (read.status !== "success") return read;
  const note = `This is the text extracted from the ${label} ${file.name}, not the file itself. Its layout, images and formatting are not shown.`;
  return {
    ...read,
    file: { ...file, given: "text" },
    notice: [
      note,
      outlined
        ? `It is long (${extracted.markdown.length.toLocaleString("en-US")} characters), so this is its outline.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
