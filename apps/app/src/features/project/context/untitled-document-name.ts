/** Suggests a stable filename slug from an untitled document's first line. */
import type { JSONContent } from "@tiptap/core";
import * as Y from "yjs";

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

/** Same suggestion, read straight from a live Yjs fragment's first block. */
export function suggestedNameFromFragment(fragment: Y.XmlFragment): string {
  const text = firstXmlBlockText(fragment);
  if (!text) return "";
  return suggestedUntitledDocumentName({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function firstXmlBlockText(fragment: Y.XmlFragment): string {
  const firstElement = fragment.toArray().find((child) => child instanceof Y.XmlElement);
  return firstElement instanceof Y.XmlElement ? xmlTextContent(firstElement).trim() : "";
}

function xmlTextContent(node: Y.XmlElement): string {
  let text = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) text += child.toString();
    if (child instanceof Y.XmlElement) text += xmlTextContent(child);
  }
  return text;
}
