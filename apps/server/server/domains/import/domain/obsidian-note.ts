/** Pure Obsidian note conversion; identity assignments travel separately from written addresses. */
import type { ImportFinding, StoredDocumentProperties } from "@meridian/contracts";
import { formatMarkdownLink, mdxCodec } from "@meridian/markup";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { scanObsidian, storedName } from "@meridian/markup/obsidian";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import {
  decodedPath,
  type ImportLinkCandidate,
  type ImportLinkIndex,
  normalizedPath,
  readFrontmatter,
} from "./link-index.js";

const codec = mdxCodec({ schema: buildDocumentSchema() });
export interface ConvertedObsidianNote {
  markdown: string;
  properties: StoredDocumentProperties | null;
  aliases: string[];
  findings: ImportFinding[];
  /** Occurrence numbers in the binder's codec walk, including images. */
  targets: Map<number, string>;
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
  const identities = new Map<string, string>();
  for (const finding of scan.findings) {
    if (finding.kind !== "wikilink" && finding.kind !== "markdownLink") continue;
    const wiki = finding.kind === "wikilink";
    const written = wiki ? finding.linkpath : finding.url;
    if (!wiki && /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(written)) continue;
    const hash = wiki ? -1 : written.indexOf("#");
    const path = hash < 0 ? written : written.slice(0, hash);
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
      decodedPath(path).split("/").at(-1) ||
        storedName(options.source.path.split("/").at(-1) ?? ""),
    );
    let href = target?.uri ?? `${options.aheadFolder}${normalizedPath(path)}`;
    const heading = wiki ? finding.heading : hash < 0 ? null : decodedPath(written.slice(hash + 1));
    const block = wiki ? finding.block : null;
    if (heading) {
      href += `#${encodeURIComponent(heading)}`;
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
    if (target) identities.set(href, target.id);
    else
      findings.push({
        code: "link_unresolved",
        params: { text: path, folder: options.aheadFolder },
      });
    if (match?.existing)
      findings.push({ code: "link_to_existing", params: { text: path, path: match.target.uri } });
    if (match?.alias)
      findings.push({ code: "link_via_alias", params: { text: path, path: match.target.uri } });
    if (match && match.candidates.length > 1)
      findings.push({
        code: "link_ambiguous",
        params: {
          text: path,
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
    const label = wiki ? finding.label || `${name}${heading ? ` > ${heading}` : ""}` : null;
    let replacement: string;
    if (wiki) replacement = `${image ? "!" : ""}${formatMarkdownLink(label ?? name, href)}`;
    else {
      // Keep labels, inline formatting and optional title; replace only the destination.
      const original = scan.source.slice(finding.from, finding.to);
      const replaced = replaceDestination(original, href);
      if (replaced === null) continue;
      replacement = replaced;
    }
    if (wiki && embed && !image) {
      findings.push({
        code:
          target?.kind === "note" || target?.kind === "docx" || !target
            ? "note_embed_to_link"
            : "embed_to_link",
        params: { name },
      });
      replacement = `\n\n${replacement}\n\n`;
    }
    if (wiki && finding.size)
      findings.push({
        code: "image_size_dropped",
        params: {
          name,
          size: `${finding.size.width}${finding.size.height ? `x${finding.size.height}` : ""}`,
        },
      });
    edits.push({ from: finding.from, to: finding.to, text: replacement });
  }
  let markdown = scan.source;
  for (const edit of edits.sort((a, b) => b.from - a.from))
    markdown = markdown.slice(0, edit.from) + edit.text + markdown.slice(edit.to);
  const targets = new Map<number, string>();
  walkLinkOccurrences(codec.parse(markdown).blocks).forEach((occurrence, index) => {
    const href = occurrence.attrs.href;
    const id = typeof href === "string" ? identities.get(href) : undefined;
    if (id) targets.set(index, id);
  });
  return { markdown, properties, aliases: parsed.aliases, findings, targets };
}

/** Replace a Markdown inline destination, respecting escapes and balanced parentheses. */
function replaceDestination(original: string, href: string): string | null {
  const opening = /\]\(\s*/.exec(original);
  if (!opening) return null;
  const start = (opening.index ?? 0) + opening[0].length;
  let end = start,
    depth = 0;
  if (original[start] === "<") {
    end++;
    while (end < original.length && original[end] !== ">") {
      if (original[end] === "\\") end++;
      end++;
    }
    if (original[end] !== ">") return null;
    end++;
  } else {
    while (end < original.length) {
      const character = original[end];
      if (character === "\\") {
        end += 2;
        continue;
      }
      if (character === "(") depth++;
      else if (character === ")") {
        if (!depth) break;
        depth--;
      } else if (/\s/.test(character) && !depth) break;
      end++;
    }
  }
  return original.slice(0, start) + formatMarkdownLink("", href).slice(3, -1) + original.slice(end);
}
