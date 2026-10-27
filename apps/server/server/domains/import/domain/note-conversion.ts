/** Pure wiki-style note conversion; identity assignments travel separately from written addresses. */
import type { StoredDocumentProperties } from "@meridian/contracts";
import { formatMarkdownLink, mdxCodec } from "@meridian/markup";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { scanWikilinks, storedName } from "@meridian/markup/wikilinks";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { readFrontmatter } from "../../context/index.js";
import {
  decodedDestination,
  type ImportLinkCandidate,
  type ImportLinkIndex,
  normalizedPath,
} from "./link-index.js";

const codec = mdxCodec({ schema: buildDocumentSchema() });
/** One converted destination: its target identity and how its address is spelled. */
interface Destination {
  targetId: string | null;
  /** Address used when the target has no override: its candidate URI or the ahead location. */
  href: string;
  /** `#heading` kept after the target's address. */
  fragment: string;
}
/** The immutable result of converting one note; `respell` turns it into written hrefs. */
export interface ConvertedNote {
  properties: StoredDocumentProperties | null;
  aliases: string[];
  /**
   * What binding parses: every converted destination is a unique placeholder,
   * so each source link is its own occurrence even where real addresses would
   * make adjacent links one run.
   */
  template: string;
  /** Planned identity per occurrence of `template`'s parse, including images. */
  targets: Map<number, string>;
  /** Every converted occurrence of `template`'s parse and its destination. */
  destinations: Map<number, Destination>;
}
export function convertNote(
  text: string,
  options: {
    source: ImportLinkCandidate;
    index: ImportLinkIndex;
    attachmentFolder: string;
    aheadFolder: string;
  },
): ConvertedNote {
  const scan = scanWikilinks(text);
  const frontmatter = scan.findings.find((finding) => finding.kind === "frontmatter");
  const properties: StoredDocumentProperties | null = frontmatter
    ? { format: "yaml", text: frontmatter.text }
    : null;
  const parsed = frontmatter ? readFrontmatter(frontmatter.text) : null;
  const edits: { from: number; to: number; text: string }[] = frontmatter
    ? [{ from: 0, to: frontmatter.to, text: "" }]
    : [];
  // Each converted destination is written as a unique placeholder, so the codec
  // walk finds every occurrence by position, never by a (possibly shared) address.
  let nonce = "mfimport";
  while (scan.source.includes(nonce)) nonce += "x";
  const written: Destination[] = [];
  const placeholder = (entry: Destination) => `${nonce}-${written.push(entry) - 1}-z`;
  for (const finding of scan.findings) {
    if (finding.kind !== "wikilink" && finding.kind !== "markdownLink") continue;
    const wiki = finding.kind === "wikilink";
    const spelled = wiki ? finding.linkpath : finding.url;
    if (!wiki && /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(spelled)) continue;
    if (!wiki && !finding.destination) continue;
    const hash = wiki ? -1 : spelled.indexOf("#");
    const spelledPath = hash < 0 ? spelled : spelled.slice(0, hash);
    // The literal name it points at: a URL destination decodes once, a wikilink never.
    const path = wiki ? spelledPath : decodedDestination(spelledPath);
    const target = wiki
      ? path
        ? options.index.resolveLinkpath(
            path,
            options.source,
            options.attachmentFolder,
            finding.embed,
          )
        : options.source
      : options.index.resolveMarkdown(path, options.source);
    if (!wiki && !target) continue;
    const name = storedName(
      path.split("/").at(-1) || storedName(options.source.path.split("/").at(-1) ?? ""),
    );
    const href = target?.uri ?? `${options.aheadFolder}${normalizedPath(path)}`;
    const heading = wiki
      ? finding.heading
      : hash < 0
        ? null
        : decodedDestination(spelled.slice(hash + 1));
    const fragment = heading ? `#${encodeURIComponent(heading)}` : "";
    const embed = wiki ? finding.embed : finding.image;
    const image =
      embed &&
      (target
        ? ["image", "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"].includes(
            target.filetype,
          )
        : /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(path));
    const destination = placeholder({ targetId: target?.id ?? null, href, fragment });
    if (!wiki) {
      // Keep labels, nested pictures, code spans and any title; replace only the destination.
      const span = finding.destination;
      if (span) edits.push({ from: span.from, to: span.to, text: destination });
      continue;
    }
    const label = finding.label || `${name}${heading ? ` > ${heading}` : ""}`;
    let replacement = `${image ? "!" : ""}${formatMarkdownLink(label, destination)}`;
    if (embed && !image) replacement = `\n\n${replacement}\n\n`;
    edits.push({ from: finding.from, to: finding.to, text: replacement });
  }
  let template = scan.source;
  for (const edit of edits.sort((a, b) => b.from - a.from))
    template = template.slice(0, edit.from) + edit.text + template.slice(edit.to);
  const exact = new RegExp(`^${nonce}-(\\d+)-z$`);
  const targets = new Map<number, string>();
  const destinations = new Map<number, Destination>();
  walkLinkOccurrences(codec.parse(template).blocks).forEach((occurrence, index) => {
    const href = occurrence.attrs.href;
    const match = typeof href === "string" ? exact.exec(href) : null;
    const entry = match ? written[Number(match[1])] : undefined;
    if (!entry) return;
    destinations.set(index, entry);
    if (entry.targetId) targets.set(index, entry.targetId);
  });
  return {
    properties,
    aliases: parsed?.readable ? parsed.aliases : [],
    template,
    targets,
    destinations,
  };
}
/**
 * The href each converted occurrence is written with, once target ids are spelled at
 * `uris` (their live addresses). Each destination is parsed alone, so the href is
 * exactly what the written link parses to.
 */
export function respell(
  note: ConvertedNote,
  uris: ReadonlyMap<string, string>,
): Map<number, string> {
  // The bare destination as formatMarkdownLink spells it, angle brackets included.
  const spell = (href: string) => formatMarkdownLink("", href).slice(3, -1);
  const converted = [...note.destinations];
  const alone = converted.map(
    ([, entry]) =>
      `[x](${spell(`${(entry.targetId && uris.get(entry.targetId)) || entry.href}${entry.fragment}`)})`,
  );
  const parsed = walkLinkOccurrences(codec.parse(alone.join("\n\n")).blocks);
  return new Map(converted.map(([index], position) => [index, parsed[position]?.attrs.href ?? ""]));
}
