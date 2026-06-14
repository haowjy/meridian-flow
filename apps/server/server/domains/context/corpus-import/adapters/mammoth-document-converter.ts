import mammoth from "mammoth";
import TurndownService from "turndown";
import type {
  ConvertedDocument,
  CorpusImportFileKind,
  DocumentConverterPort,
} from "../ports/document-converter.js";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const TEXT_MIME_TYPES = new Set(["text/plain"]);

function extension(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? filename;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

function cleanMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function createMammothDocumentConverter(): DocumentConverterPort {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  function classify(input: { filename: string; mimeType: string }): CorpusImportFileKind {
    const ext = extension(input.filename);
    const mime = cleanMimeType(input.mimeType);
    if (ext === "docx" || mime === DOCX_MIME_TYPE) return "docx";
    if (ext === "md" || ext === "markdown" || MARKDOWN_MIME_TYPES.has(mime)) return "markdown";
    if (ext === "txt" || TEXT_MIME_TYPES.has(mime)) return "text";
    return "unsupported";
  }

  return {
    classify,
    async convert(input): Promise<ConvertedDocument> {
      const kind = classify(input);
      if (kind === "markdown" || kind === "text") {
        return { markdown: Buffer.from(input.bytes).toString("utf8"), messages: [] };
      }
      if (kind === "docx") {
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
        return {
          markdown: turndown.turndown(result.value).trim(),
          messages: result.messages.map((message) => ({
            type: message.type === "warning" ? "warning" : "info",
            message: message.message,
          })),
        };
      }
      throw new Error(`Unsupported file type: ${input.filename}`);
    },
  };
}
