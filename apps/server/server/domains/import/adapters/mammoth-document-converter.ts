/** DOCX-to-Markdown adapter without title decoration. */
import mammoth from "mammoth";
import TurndownService from "turndown";
import type { DocumentConverterPort } from "../ports/document-converter.js";
export function createMammothDocumentConverter(): DocumentConverterPort {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return {
    async convert(bytes) {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      return turndown.turndown(result.value).trim();
    },
  };
}
