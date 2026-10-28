import mammoth from "mammoth";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { DocumentConverterPort } from "../ports/document-converter.js";

// PostgreSQL's tsvector index rejects a token at 1 MiB. Mammoth's default image
// renderer puts embedded images in one data URL, which becomes one giant token
// in the Markdown projection. Keep the DOCX as an attachment instead.
const MAX_INLINE_IMAGE_DATA_BYTES = 1_000_000;
const INLINE_IMAGE_DATA = /data:image\/[^;,\s]+;base64,([A-Za-z0-9+/=_-]+)/g;

export function createMammothDocumentConverter(): DocumentConverterPort {
  const htmlToMarkdown = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true, emphasis: "_", rule: "-" });

  return {
    async convert(bytes) {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      const markdown = String(await htmlToMarkdown.process(result.value)).trim();
      for (const match of markdown.matchAll(INLINE_IMAGE_DATA)) {
        if (Buffer.byteLength(match[1], "ascii") > MAX_INLINE_IMAGE_DATA_BYTES)
          throw new Error("Embedded image is too large to index in an imported document");
      }
      return markdown;
    },
  };
}
