/** Suggests a stable filename slug from an untitled document's first line. */
import type { JSONContent } from "@tiptap/core";

export function suggestedUntitledDocumentName(content: JSONContent): string {
  const firstBlock = content.type === "doc" ? content.content?.[0] : content;
  const firstLine = collectText(firstBlock).split("\n", 1)[0]?.trim() ?? "";
  return firstLine
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function collectText(content: JSONContent | undefined): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return (content.content ?? []).map(collectText).join("");
}
