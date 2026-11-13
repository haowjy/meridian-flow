/**
 * EPUB to Markdown: the container names the package (OPF), the package's spine orders the
 * chapters, each XHTML chapter becomes Markdown. Images, scripts and links' addresses are left out.
 *
 * Hostile input: the central directory's declared sizes are checked before anything inflates, and
 * fflate inflates into a buffer of exactly the declared size, so an entry that lies about it is
 * cut, not grown. Only XML and XHTML entries are inflated. XML with an entity declaration is
 * refused whole (an XXE or entity-expansion file); XHTML goes through an HTML5 parser, which has
 * no DTD to process.
 */
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { type Unzipped, unzipSync } from "fflate";
import { createHtmlToMarkdown } from "../html-markdown.js";
import {
  CONVERSION_LIMITS,
  ConversionRefused,
  checkDeadline,
  createTextBuilder,
} from "./limits.js";

const { epub: LIMITS } = CONVERSION_LIMITS;
const ENTITY_DECLARATION = /<!ENTITY/i;
const CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html"]);

type Entry = { name: string; size: number };

/** The archive's entries as its central directory declares them, with nothing inflated. */
function listEntries(bytes: Uint8Array): Entry[] {
  const entries: Entry[] = [];
  let total = 0;
  try {
    unzipSync(bytes, {
      filter(file) {
        if (entries.length >= LIMITS.entries)
          throw new ConversionRefused("hostile", "The EPUB has too many entries.");
        if (file.originalSize > LIMITS.entryBytes)
          throw new ConversionRefused("hostile", "An entry in the EPUB is too large.");
        total += file.originalSize;
        if (total > LIMITS.totalBytes)
          throw new ConversionRefused("hostile", "The EPUB inflates to too much data.");
        entries.push({ name: file.name, size: file.originalSize });
        return false;
      },
    });
  } catch (error) {
    if (error instanceof ConversionRefused) throw error;
    throw new ConversionRefused("unreadable", "The file is not a readable EPUB archive.");
  }
  return entries;
}

function inflate(bytes: Uint8Array, wanted: ReadonlySet<string>): Unzipped {
  let total = 0;
  return unzipSync(bytes, {
    filter(file) {
      if (!wanted.has(file.name)) return false;
      if (file.originalSize > LIMITS.textEntryBytes)
        throw new ConversionRefused("hostile", "A chapter in the EPUB is too large.");
      total += file.originalSize;
      if (total > LIMITS.textTotalBytes)
        throw new ConversionRefused("hostile", "The EPUB's text is too large.");
      return true;
    },
  });
}

function xmlText(data: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(data);
  if (ENTITY_DECLARATION.test(text))
    throw new ConversionRefused("hostile", "The EPUB declares XML entities, which are refused.");
  return text;
}

function parseXml(text: string): Document {
  const document = new DOMParser({ errorHandler: () => {} }).parseFromString(text, "text/xml");
  if (!document?.documentElement)
    throw new ConversionRefused("unreadable", "The EPUB's package file is not valid XML.");
  return document as unknown as Document;
}

function resolveEntry(from: string, href: string): string {
  const target = decodeURIComponent(href.split("#")[0] ?? "");
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
}

export async function epubToMarkdown(bytes: Uint8Array, deadline: number): Promise<string> {
  const names = new Set(listEntries(bytes).map((entry) => entry.name));
  const container = inflate(bytes, new Set(["META-INF/container.xml"]))["META-INF/container.xml"];
  if (!container) throw new ConversionRefused("unreadable", "The EPUB has no container.xml.");
  const rootfile = parseXml(xmlText(container)).getElementsByTagName("rootfile")[0];
  const packagePath = rootfile?.getAttribute("full-path");
  if (!packagePath || !names.has(packagePath))
    throw new ConversionRefused("unreadable", "The EPUB names no package file.");

  const packageData = inflate(bytes, new Set([packagePath]))[packagePath];
  const pkg = parseXml(xmlText(packageData));
  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of Array.from(pkg.getElementsByTagName("item"))) {
    manifest.set(item.getAttribute("id") ?? "", {
      href: item.getAttribute("href") ?? "",
      type: item.getAttribute("media-type") ?? "",
    });
  }
  const chapters = Array.from(pkg.getElementsByTagName("itemref")).flatMap((ref) => {
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item || !CONTENT_TYPES.has(item.type)) return [];
    const entry = resolveEntry(packagePath, item.href);
    return names.has(entry) ? [entry] : [];
  });
  if (chapters.length === 0) throw new ConversionRefused("no_text", "The EPUB has no text.");

  const files = inflate(bytes, new Set(chapters));
  const htmlToMarkdown = createHtmlToMarkdown({ textOnly: true });
  const out = createTextBuilder();
  const title = pkg.getElementsByTagName("dc:title")[0]?.textContent?.trim().replace(/\s+/g, " ");
  let titled = false;
  for (const [index, entry] of chapters.entries()) {
    checkDeadline(deadline);
    const data = files[entry];
    if (!data) continue;
    const markdown = await htmlToMarkdown(xmlText(data));
    if (!markdown) continue;
    // The book's title heads the text unless the first chapter already does.
    if (!titled) {
      titled = true;
      if (title && !markdown.startsWith(`# ${title}`)) out.add(`# ${title}`);
    }
    // A chapter with no heading of its own still needs one for the outline to name it.
    const kept = /^#{1,6}\s/m.test(markdown) ? markdown : `## Part ${index + 1}\n\n${markdown}`;
    if (!out.add(kept)) break;
  }
  const text = out.text();
  if (!/\S/.test(text.replace(/^#.*$/gm, "")))
    throw new ConversionRefused("no_text", "The EPUB has no text.");
  return text;
}
