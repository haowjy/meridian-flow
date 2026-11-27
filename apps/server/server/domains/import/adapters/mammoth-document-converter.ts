import { createHash } from "node:crypto";
import mammoth from "mammoth";
import { createHtmlToMarkdown } from "../../file-intake/html-markdown.js";
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
  const htmlToMarkdown = createHtmlToMarkdown();

  return {
    async convert(bytes, imageFolder) {
      const images: ConvertedImage[] = [];
      const nameByHash = new Map<string, string>();
      const result = await mammoth.convertToHtml(
        { buffer: Buffer.from(bytes) },
        {
          convertImage: mammoth.images.imgElement(async (image) => {
            const data = await image.readAsBuffer();
            // No await after reading an image; the name counter must stay non-interleaved
            const hash = createHash("sha256").update(data).digest("hex");
            let name = nameByHash.get(hash);
            if (!name) {
              name = `image-${images.length + 1}.${imageExtension(image.contentType)}`;
              nameByHash.set(hash, name);
              images.push({ name, bytes: data });
            }
            // Collapse Word alt-text whitespace; blank lines terminate a Markdown image
            return {
              src: `${encodeURIComponent(imageFolder)}/${name}`,
              alt: (image as { altText?: string }).altText?.replace(/\s+/g, " ").trim() ?? "",
            };
          }),
        },
      );
      const markdown = await htmlToMarkdown(result.value);
      return { markdown, images };
    },
  };
}
