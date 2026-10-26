import mammoth from "mammoth";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { DocumentConverterPort } from "../ports/document-converter.js";

export function createMammothDocumentConverter(): DocumentConverterPort {
  const htmlToMarkdown = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true, emphasis: "_", rule: "-" });

  return {
    async convert(bytes) {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      return String(await htmlToMarkdown.process(result.value)).trim();
    },
  };
}
