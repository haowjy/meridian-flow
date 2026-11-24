import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

type HastNode = { type: string; tagName?: string; children?: HastNode[] };

const DROPPED = new Set(["head", "script", "style", "svg", "img", "audio", "video", "iframe"]);

function textOnly(node: HastNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "comment" || child.type === "doctype") return [];
    if (child.tagName && DROPPED.has(child.tagName)) return [];
    textOnly(child);
    return child.tagName === "a" ? (child.children ?? []) : [child];
  });
}

export function createHtmlToMarkdown(options: { textOnly?: boolean } = {}) {
  const processor = unified()
    .use(rehypeParse, { fragment: !options.textOnly })
    .use(() => (tree: HastNode) => {
      if (options.textOnly) textOnly(tree);
    })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true, emphasis: "_", rule: "-" });
  return async (html: string): Promise<string> => String(await processor.process(html)).trim();
}
