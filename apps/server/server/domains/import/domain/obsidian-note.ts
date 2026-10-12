/** Pure Obsidian note conversion; identity assignments travel separately from written addresses. */
import type { ImportFinding, StoredDocumentProperties } from "@meridian/contracts";
import { formatMarkdownLink, mdxCodec } from "@meridian/markup";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { scanObsidian, storedName } from "@meridian/markup/obsidian";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import {
  decodedDestination,
  type ImportLinkCandidate,
  type ImportLinkIndex,
  normalizedPath,
  readFrontmatter,
} from "./link-index.js";

const codec = mdxCodec({ schema: buildDocumentSchema() });
export interface ConvertedObsidianNote {
  /** The note as written, with converted destinations at their addresses; for reading only. */
  markdown: string;
  properties: StoredDocumentProperties | null;
  aliases: string[];
  findings: ImportFinding[];
  /**
   * What binding parses: every converted destination is a unique placeholder,
   * so each source link is its own occurrence even where real addresses would
   * make adjacent links one run.
   */
  template: string;
  /** Planned identity per occurrence of `template`'s parse, including images. */
  targets: Map<number, string>;
  /** Written href per converted occurrence of `template`'s parse. */
  hrefs: Map<number, string>;
  /** Spell these target ids at other addresses; occurrences are unchanged. */
  readdress(uris: ReadonlyMap<string, string>): void;
}
/** One converted destination: its target identity and how its address is spelled. */
interface Written {
  targetId: string | null;
  /** Address used when the target has no override: its candidate URI or the ahead location. */
  href: string;
  /** `#heading` kept after the target's address. */
  fragment: string;
}
export function convertObsidianNote(
  text: string,
  options: {
    source: ImportLinkCandidate;
    index: ImportLinkIndex;
    attachmentFolder: string;
    aheadFolder: string;
  },
): ConvertedObsidianNote {
  const scan = scanObsidian(text);
  const frontmatter = scan.findings.find((finding) => finding.kind === "frontmatter");
  const properties: StoredDocumentProperties | null = frontmatter
    ? { format: "yaml", text: frontmatter.text }
    : null;
  const parsed = frontmatter ? readFrontmatter(frontmatter.text) : { readable: true, aliases: [] };
  const findings: ImportFinding[] = [];
  const comments = scan.findings.filter((finding) => finding.kind === "comment");
  if (comments.length) findings.push({ code: "hidden_notes", params: { count: comments.length } });
  if (!parsed.readable) findings.push({ code: "properties_unreadable", params: {} });
  const counts = {
    callouts: scan.findings.filter((finding) => finding.kind === "callout").length,
    highlights: scan.findings.filter((finding) => finding.kind === "highlight").length,
    tags: scan.findings.filter((finding) => finding.kind === "tag").length,
    footnotes: scan.findings.filter(
      (finding) => finding.kind === "footnoteReference" || finding.kind === "footnoteDefinition",
    ).length,
  };
  if (Object.values(counts).some(Boolean)) findings.push({ code: "kept_as_text", params: counts });
  const edits: { from: number; to: number; text: string }[] = frontmatter
    ? [{ from: 0, to: frontmatter.to, text: "" }]
    : [];
  // Each converted destination is written as a unique placeholder, so the codec
  // walk finds every occurrence by position, never by a (possibly shared) address.
  let nonce = "mfimport";
  while (scan.source.includes(nonce)) nonce += "x";
  const written: Written[] = [];
  const placeholder = (entry: Written) => `${nonce}-${written.push(entry) - 1}-z`;
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
    const match = wiki
      ? path
        ? options.index.resolveLinkpath(
            path,
            options.source,
            options.attachmentFolder,
            finding.embed,
          )
        : { target: options.source, candidates: [options.source], alias: false, existing: false }
      : null;
    const target = wiki ? match?.target : options.index.resolveMarkdown(path, options.source);
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
    const block = wiki ? finding.block : null;
    const fragment = heading ? `#${encodeURIComponent(heading)}` : "";
    if (heading) {
      findings.push({
        code: "heading_not_followed",
        params: { text: scan.source.slice(finding.from, finding.to), name, heading },
      });
    }
    if (block)
      findings.push({
        code: "block_ref_dropped",
        params: { text: scan.source.slice(finding.from, finding.to), name },
      });
    if (!target)
      findings.push({
        code: "link_unresolved",
        params: { text: spelledPath, folder: options.aheadFolder },
      });
    if (match?.existing)
      findings.push({
        code: "link_to_existing",
        params: { text: spelledPath, path: match.target.uri },
      });
    if (match?.alias)
      findings.push({
        code: "link_via_alias",
        params: { text: spelledPath, path: match.target.uri },
      });
    if (match && match.candidates.length > 1)
      findings.push({
        code: "link_ambiguous",
        params: {
          text: spelledPath,
          count: match.candidates.length,
          path: match.target.uri,
          candidates: match.candidates.map((candidate) => candidate.uri),
        },
      });
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
    if (embed && !image) {
      findings.push({
        code:
          target?.kind === "note" || target?.kind === "docx" || !target
            ? "note_embed_to_link"
            : "embed_to_link",
        params: { name },
      });
      replacement = `\n\n${replacement}\n\n`;
    }
    if (finding.size)
      findings.push({
        code: "image_size_dropped",
        params: {
          name,
          size: `${finding.size.width}${finding.size.height ? `x${finding.size.height}` : ""}`,
        },
      });
    edits.push({ from: finding.from, to: finding.to, text: replacement });
  }
  let template = scan.source;
  for (const edit of edits.sort((a, b) => b.from - a.from))
    template = template.slice(0, edit.from) + edit.text + template.slice(edit.to);
  const exact = new RegExp(`^${nonce}-(\\d+)-z$`);
  const targets = new Map<number, string>();
  /** Occurrence of the template's parse → its entry in `written`. */
  const converted = new Map<number, number>();
  walkLinkOccurrences(codec.parse(template).blocks).forEach((occurrence, index) => {
    const href = occurrence.attrs.href;
    const match = typeof href === "string" ? exact.exec(href) : null;
    const entry = match ? written[Number(match[1])] : undefined;
    if (!entry) return;
    converted.set(index, Number(match?.[1]));
    if (entry.targetId) targets.set(index, entry.targetId);
  });
  // The bare destination as formatMarkdownLink spells it, angle brackets included.
  const spell = (href: string) => formatMarkdownLink("", href).slice(3, -1);
  const note: ConvertedObsidianNote = {
    markdown: "",
    properties,
    aliases: parsed.aliases,
    findings,
    template,
    targets,
    hrefs: new Map(),
    readdress(uris) {
      const spelled = written.map((entry) =>
        spell(`${(entry.targetId && uris.get(entry.targetId)) || entry.href}${entry.fragment}`),
      );
      note.markdown = template.replace(
        new RegExp(`${nonce}-(\\d+)-z`, "g"),
        (_, index: string) => spelled[Number(index)] ?? "",
      );
      // Each destination parsed alone, so its href is exactly what the written link parses to.
      const alone = [...converted.values()].map((entry) => `[x](${spelled[entry]})`);
      const hrefs = walkLinkOccurrences(codec.parse(alone.join("\n\n")).blocks);
      note.hrefs = new Map(
        [...converted.keys()].map((index, position) => [index, hrefs[position]?.attrs.href ?? ""]),
      );
    },
  };
  note.readdress(new Map());
  return note;
}
