import { readSegment } from "@meridian/contracts/protocol";
import type { AssistantView } from "@meridian/thread-client";
import { harden } from "rehype-harden";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { classifyLinkTarget } from "@/core/editor/links";
import { payloadText } from "./report-payload";

const copyProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(() => (tree, file) => prepareCopyAst(tree as CopyAst, String(file.value)))
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, {
    ...defaultSchema,
    clobberPrefix: "",
    attributes: {
      ...defaultSchema.attributes,
      code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
    },
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), "tel"],
    },
  })
  .use(harden, {
    allowedImagePrefixes: ["*"],
    allowedLinkPrefixes: ["*"],
    allowedProtocols: ["*"],
    allowDataImages: true,
  })
  .use(() => (tree) => stripPresentation(tree))
  .use(rehypeStringify);

export function assistantTurnCopyMarkdown({ items, finalFrom }: AssistantView): string {
  return items
    .slice(finalFrom)
    .flatMap((item) => {
      if (item.kind === "text") return [item.text];
      if (item.kind === "report") {
        const payload = payloadText(item.report.payload);
        return [item.report.summary, ...(payload.trim() ? [`\`\`\`json\n${payload}\n\`\`\``] : [])];
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

function prepareCopyAst(node: CopyAst, source: string): void {
  if (node.type === "code" && node.meta) {
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, metastring: node.meta } };
  }
  const target = node.type === "link" && node.url ? classifyLinkTarget(node.url) : null;
  if (target && target.kind !== "external") {
    const label = node.children?.[0];
    if (
      target.kind === "scheme" &&
      source[node.position?.start.offset ?? -1] !== "[" &&
      node.children?.length === 1 &&
      label !== undefined &&
      label.value === node.url
    ) {
      label.value = readSegment(target.uri.split("/").at(-1) ?? "").name || target.uri;
    }
    node.type = "copyLabel";
    node.data = { hName: "meridian-copy-label" };
  }
  for (const child of node.children ?? []) prepareCopyAst(child, source);
}
type CopyAst = {
  type: string;
  url?: string;
  value?: string;
  position?: { start: { offset?: number } };
  meta?: string;
  data?: { hName?: string; hProperties?: Record<string, string> };
  children?: CopyAst[];
};
