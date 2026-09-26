/** Select and serialize the writer-facing final answer from an assistant turn. */
import type { Turn } from "@meridian/contracts/protocol";
import { remarkWikiLink } from "@meridian/markup";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { unified } from "unified";
import { remarkReferenceOccurrences } from "@/rich-content/reference-occurrences";
import { partitionTurn } from "./partition-turn";
import { payloadText } from "./ReportContent";

export type AssistantTurnCopy = { markdown: string; html: string };

/** Keep only prose/report items after the last thinking/tool fold. */
export function assistantTurnCopyMarkdown(turn: Turn): string {
  const items = partitionTurn([...turn.blocks].sort((a, b) => a.sequence - b.sequence));
  let lastProcess = -1;
  items.forEach((item, index) => {
    if (item.kind === "process") lastProcess = index;
  });
  return items
    .slice(lastProcess + 1)
    .flatMap((item) => {
      if (item.kind === "text") return [item.block.textContent ?? ""];
      if (item.kind === "report")
        return [item.report.summary, payloadText(item.report.payload)].filter((part) =>
          part.trim(),
        );
      return [];
    })
    .filter((part) => part.trim())
    .join("\n\n");
}

/** Render with the transcript's Markdown pipeline, then remove app-only presentation. */
export function assistantTurnCopy(turn: Turn): AssistantTurnCopy {
  const markdown = assistantTurnCopyMarkdown(turn);
  const processor = unified()
    .use(remarkParse)
    .use(Object.values(defaultRemarkPlugins))
    .use(remarkWikiLink)
    .use(remarkReferenceOccurrences, { occurrences: [], skills: [] })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(Object.values(defaultRehypePlugins))
    .use(rehypeStringify);
  const rendered = String(processor.processSync(markdown));
  return { markdown, html: cleanCopiedHtml(rendered) };
}

function cleanCopiedHtml(html: string): string {
  return html
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, "")
    .replace(
      /\s(?:class|style|role|tabindex|target|rel|aria-[\w-]+|data-[\w-]+)=(?:"[^"]*"|'[^']*')/gi,
      "",
    );
}
