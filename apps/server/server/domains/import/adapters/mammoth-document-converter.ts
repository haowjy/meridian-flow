import { createHash } from "node:crypto";
import mammoth from "mammoth";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { ConvertedImage, DocumentConverterPort } from "../ports/document-converter.js";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-emf": "emf",
  "image/x-wmf": "wmf",
  "image/x-tiff": "tiff",
};

function imageExtension(contentType: string): string {
  const subtype = contentType
    .split("/")[1]
    ?.replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return EXTENSIONS[contentType.toLowerCase()] ?? (subtype || "bin");
}

export function createMammothDocumentConverter(): DocumentConverterPort {
  const htmlToMarkdown = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true, emphasis: "_", rule: "-" });

  return {
    async convert(bytes, imageFolder) {
      const images: ConvertedImage[] = [];
      const nameByHash = new Map<string, string>();
      const result = await mammoth.convertToHtml(
        { buffer: Buffer.from(bytes) },
        {
          // Embedded images become files the Markdown links to, never data: URLs.
          convertImage: mammoth.images.imgElement(async (image) => {
            const data = await image.readAsBuffer();
            // No await past here: the name counter must not interleave.
            const hash = createHash("sha256").update(data).digest("hex");
            let name = nameByHash.get(hash);
            if (!name) {
              name = `image-${images.length + 1}.${imageExtension(image.contentType)}`;
              nameByHash.set(hash, name);
              images.push({ name, bytes: data });
            }
            // Word alt text can hold blank lines, which end a Markdown image early.
            // Mammoth passes `altText` at runtime but does not type it.
            return {
              src: `${encodeURIComponent(imageFolder)}/${name}`,
              alt: (image as { altText?: string }).altText?.replace(/\s+/g, " ").trim() ?? "",
            };
          }),
        },
      );
      const markdown = String(await htmlToMarkdown.process(result.value)).trim();
      return { markdown, images };
    },
  };
}
