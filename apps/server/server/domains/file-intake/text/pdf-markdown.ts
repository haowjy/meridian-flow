/**
 * PDF to Markdown with pdf.js (through unpdf, its packaging for Node and serverless runtimes:
 * one dependency, no worker, no canvas, no native build). Layout becomes structure by type size: a
 * short line set larger than the body text is a heading; a gap taller than the line spacing is a
 * paragraph break. A PDF with no such headings gets a `Page N` heading per page, so its outline
 * can name pages.
 */
import { getDocumentProxy } from "unpdf";
import {
  CONVERSION_LIMITS,
  ConversionRefused,
  checkDeadline,
  createTextBuilder,
} from "./limits.js";

type Line = { text: string; size: number; y: number };
type Page = { lines: Line[] };

const MAX_HEADING_CHARS = 120;
/** Heading levels by type size relative to the body text, largest first. */
const HEADING_RATIOS = [1.6, 1.3, 1.12] as const;

/** Page items in stream order, joined into lines wherever baselines agree. */
async function readPage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>["getPage"]>>,
): Promise<Page> {
  const { items } = await page.getTextContent();
  const lines: Line[] = [];
  for (const item of items) {
    if (!("str" in item)) continue;
    const size = Math.abs(item.transform[3]) || item.height;
    const y = item.transform[5];
    const last = lines.at(-1);
    if (last && Math.abs(last.y - y) < size * 0.5) {
      last.text += item.str;
      last.size = Math.max(last.size, size);
    } else if (item.str.trim()) {
      lines.push({ text: item.str, size, y });
    }
  }
  return { lines: lines.filter((line) => line.text.trim()) };
}

/** Characters a Markdown parser would take for syntax, so extracted text stays text. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]<>#|~])/g, "\\$1").replace(/^([-+]|\d+[.)])(\s)/, "\\$1$2");
}

function bodySize(pages: readonly Page[]): number {
  const weight = new Map<number, number>();
  for (const { lines } of pages)
    for (const line of lines) {
      const size = Math.round(line.size * 2) / 2;
      weight.set(size, (weight.get(size) ?? 0) + line.text.length);
    }
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

function pageToMarkdown(page: Page, body: number): string[] {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let previous: Line | undefined;
  const flush = () => {
    if (paragraph.length > 0) blocks.push(escapeMarkdown(paragraph.join(" ")));
    paragraph = [];
  };
  for (const line of page.lines) {
    const text = line.text.replace(/\s+/g, " ").trim();
    const level = HEADING_RATIOS.findIndex((ratio) => line.size >= body * ratio);
    if (level >= 0 && text.length <= MAX_HEADING_CHARS) {
      flush();
      blocks.push(`${"#".repeat(level + 1)} ${escapeMarkdown(text)}`);
    } else {
      if (previous && Math.abs(previous.y - line.y) > line.size * 1.8) flush();
      paragraph.push(
        paragraph.length > 0 && paragraph[paragraph.length - 1].endsWith("-")
          ? `${paragraph.pop()?.slice(0, -1)}${text}`
          : text,
      );
    }
    previous = line;
  }
  flush();
  return blocks;
}

export async function pdfToMarkdown(bytes: Uint8Array, deadline: number): Promise<string> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy: pdf.js takes ownership of the buffer it is given.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new ConversionRefused(
      "unreadable",
      name === "PasswordException" ? "The PDF is password protected." : "The PDF can't be read.",
    );
  }
  try {
    if (pdf.numPages > CONVERSION_LIMITS.pdf.pages)
      throw new ConversionRefused("too_large", "The PDF has too many pages.");
    const pages: Page[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      checkDeadline(deadline);
      pages.push(await readPage(await pdf.getPage(number)));
    }
    const body = bodySize(pages);
    const converted = pages.map((page) => pageToMarkdown(page, body));
    const headings = converted.some((blocks) => blocks.some((block) => block.startsWith("#")));
    const out = createTextBuilder();
    for (const [index, blocks] of converted.entries()) {
      if (blocks.length === 0) continue;
      const withPage =
        headings || pages.length === 1 ? blocks : [`## Page ${index + 1}`, ...blocks];
      if (!out.add(withPage.join("\n\n"))) break;
    }
    const text = out.text();
    if (!text) throw new ConversionRefused("no_text", "The PDF has no text to extract.");
    return text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
