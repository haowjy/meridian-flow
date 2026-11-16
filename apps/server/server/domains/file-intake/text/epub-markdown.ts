/**
 * EPUB to Markdown: the container names the package (OPF), the package's spine orders the
 * chapters, each XHTML chapter becomes Markdown. Images, scripts and links' addresses are left out.
 *
 * Hostile input: the central directory's declared sizes are checked before anything inflates, and
 * fflate inflates into a buffer of exactly the declared size, so an entry that lies about it is
 * cut, not grown. Only XML and XHTML entries are inflated. XML with an entity declaration is
 * refused whole (an XXE or entity-expansion file); the package files go through htmlparser2 in XML
 * mode and the chapters through an HTML5 parser, and neither processes a DTD.
 */
import path from "node:path";
import { type Unzipped, unzipSync } from "fflate";
import { Parser } from "htmlparser2";
import { createHtmlToMarkdown } from "../html-markdown.js";
import { CONVERSION_LIMITS, ConversionRefused, createTextBuilder } from "./limits.js";

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

type Scan = {
  rootfile?: string;
  items: Map<string, { href: string; type: string }>;
  itemrefs: string[];
  title?: string;
};

/**
 * One streaming pass over the container or package file, with no tree: a lookup per tag name over
 * a tree of unclosed `<item>`s nests as deep as the file is long and costs the square of it. The
 * parser is lenient XML: `<item/>` closes itself, CDATA is text, and an unclosed or mismatched
 * tag, a duplicate attribute or an unquoted value still reads instead of throwing. Names keep
 * their case, as XML does. The first `rootfile` and the first `dc:title` win.
 */
function scanXml(text: string): Scan {
  const scan: Scan = { items: new Map(), itemrefs: [] };
  let titleDepth = 0;
  let titleText = "";
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (titleDepth > 0) titleDepth++;
        else if (name === "dc:title" && scan.title === undefined) titleDepth = 1;
        else if (name === "rootfile") scan.rootfile ??= attribs["full-path"];
        else if (name === "item")
          scan.items.set(attribs.id ?? "", {
            href: attribs.href ?? "",
            type: attribs["media-type"] ?? "",
          });
        else if (name === "itemref") scan.itemrefs.push(attribs.idref ?? "");
      },
      ontext(data) {
        if (titleDepth > 0) titleText += data;
      },
      onclosetag() {
        if (titleDepth > 0 && --titleDepth === 0)
          scan.title = titleText.trim().replace(/\s+/g, " ");
      },
    },
    { xmlMode: true },
  );
  parser.write(text);
  parser.end();
  return scan;
}

function resolveEntry(from: string, href: string): string {
  const target = decodeURIComponent(href.split("#")[0] ?? "");
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
}

export async function epubToMarkdown(bytes: Uint8Array): Promise<string> {
  const names = new Set(listEntries(bytes).map((entry) => entry.name));
  const container = inflate(bytes, new Set(["META-INF/container.xml"]))["META-INF/container.xml"];
  if (!container) throw new ConversionRefused("unreadable", "The EPUB has no container.xml.");
  const packagePath = scanXml(xmlText(container)).rootfile;
  if (!packagePath || !names.has(packagePath))
    throw new ConversionRefused("unreadable", "The EPUB names no package file.");

  const packageData = inflate(bytes, new Set([packagePath]))[packagePath];
  const { items: manifest, itemrefs, title } = scanXml(xmlText(packageData));
  const chapters = itemrefs.flatMap((idref) => {
    const item = manifest.get(idref);
    if (!item || !CONTENT_TYPES.has(item.type)) return [];
    const entry = resolveEntry(packagePath, item.href);
    return names.has(entry) ? [entry] : [];
  });
  if (chapters.length === 0) throw new ConversionRefused("no_text", "The EPUB has no text.");

  const files = inflate(bytes, new Set(chapters));
  const htmlToMarkdown = createHtmlToMarkdown({ textOnly: true });
  const out = createTextBuilder();
  let titled = false;
  for (const [index, entry] of chapters.entries()) {
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
