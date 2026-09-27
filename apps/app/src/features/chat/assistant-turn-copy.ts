/** Serialize the visible final answer into Markdown and app-free rich clipboard HTML. */
import { remarkWikiLink } from "@meridian/markup";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { unified } from "unified";
import { remarkReferenceOccurrences } from "@/rich-content/reference-occurrences";
import { imageContentForBlock, isImageBlock } from "./block-kind";
import { finalMessageItems, type RenderItem } from "./partition-turn";
import { payloadText } from "./report-payload";

const copyProcessor = unified()
  .use(remarkParse)
  .use(Object.values(defaultRemarkPlugins))
  .use(remarkWikiLink)
  .use(remarkReferenceOccurrences, { occurrences: [], skills: [] })
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(Object.values(defaultRehypePlugins))
  .use(() => (tree) => stripPresentation(tree))
  .use(rehypeStringify);

/** Build Markdown eagerly for the disabled state; rich HTML is deferred until copy. */
export function assistantTurnCopyMarkdown(items: RenderItem[]): string {
  return finalMessageItems(items)
    .flatMap((item) => {
      if (item.kind === "text") return [item.block.textContent ?? ""];
      if (item.kind === "report") {
        const payload = payloadText(item.report.payload);
        return [item.report.summary, ...(payload.trim() ? [`\`\`\`json\n${payload}\n\`\`\``] : [])];
      }
      if (item.kind === "artifact" && isImageBlock(item.block)) {
        const image = imageContentForBlock(item.block);
        if (!image) return [];
        const alt = (image.alt ?? image.caption ?? "").replace(/[[\]]/g, "");
        return [`![${alt}](<${image.url}>)`, ...(image.caption ? [image.caption] : [])];
      }
      return [];
    })
    .filter((part) => part.trim())
    .join("\n\n");
}

export function assistantTurnCopyHtml(markdown: string): string {
  return String(copyProcessor.processSync(markdown));
}

function stripPresentation(tree: HastNode): void {
  if (!Array.isArray(tree.children)) return;
  tree.children = tree.children.filter(
    (node) => node.type !== "element" || node.tagName !== "button",
  );
  for (const node of tree.children) {
    if (node.type === "element" && node.properties) {
      for (const key of Object.keys(node.properties)) {
        // className is intentionally stripped; KaTeX relies on it for styling,
        // so copied math remains semantic HTML but pastes without KaTeX styles.
        if (
          /^(className|style|role|tabIndex|target|rel)$/.test(key) ||
          /^(aria|data)[A-Z-]/i.test(key)
        ) {
          delete node.properties[key];
        }
      }
    }
    stripPresentation(node);
  }
}

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};
