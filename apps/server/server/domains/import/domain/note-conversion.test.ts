/** Conversion contracts without storage, using the main vault and adversarial syntax. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { splitFrontmatter } from "@meridian/markup/wikilinks";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { parseDocumentProperties } from "../../context/document-properties.js";
import { MAX_PROPERTIES_TEXT_LENGTH } from "../../context/frontmatter.js";
import { createLinkIndex, type ImportLinkCandidate, obsidianSettings } from "./link-index.js";
import { convertNote } from "./note-conversion.js";

const root = new URL("../__fixtures__/notes-folder/", import.meta.url).pathname;
function candidate(
  path: string,
  aliases: string[] = [],
  uri = `kb://vault/${path.replace(/\.(md|txt)$/i, "")}`,
): ImportLinkCandidate {
  return {
    id: path,
    path,
    uri,
    rootId: 0,
    aliases,
    kind: path.endsWith(".png") ? "binary" : "note",
    filetype: path.endsWith(".png") ? "image" : "markdown",
  };
}
const paths = [
  "Chapters/Chapter 1 - The Gate.md",
  "Chapters/Ch 2.md",
  "Chapters/Chapter 3 - Ash.txt",
  "Chapters/Sects and Clans.md",
  "Characters/Lin Feng.md",
  "Lore/Cultivation Realms.md",
  "Lore/Sects.md",
  "Lore/Magic System.md",
  "Lore/magic system.md",
  "Lore.md",
  "attachments/map.png",
];
const selected = paths.map((path) =>
  candidate(
    path,
    path === "Lore.md"
      ? ["World Bible"]
      : path === "Characters/Lin Feng.md"
        ? ["Little Crane"]
        : [],
    path === "Lore.md" ? "kb://vault/Lore/Lore" : undefined,
  ),
);
function convert(
  text: string,
  source = selected[0],
  pool = selected,
  existing: ImportLinkCandidate[] = [],
) {
  return convertNote(text, {
    source,
    index: createLinkIndex(pool, existing),
    attachmentFolder: "attachments",
    aheadFolder: "kb://vault/",
  });
}
const codec = mdxCodec({ schema: buildDocumentSchema() });
function links(markdown: string) {
  return walkLinkOccurrences(codec.parse(markdown).blocks);
}

describe("note conversion", () => {
  it("removes frontmatter verbatim, extracts aliases, binds all Chapter 1 occurrences including its image", () => {
    const text = readFileSync(join(root, paths[0]), "utf8");
    const converted = convert(text);
    expect(converted.properties?.text).toBe(splitFrontmatter(text).frontmatter?.text);
    expect(converted.aliases).toEqual(["Gate Opening", "First Chapter"]);
    expect(converted.markdown.trimStart()).toMatch(/^# Chapter 1: The Gate/);
    expect(links(converted.markdown).map((link) => [link.label, link.attrs.href])).toEqual([
      ["the protagonist", "kb://vault/Characters/Lin Feng"],
      ["Cultivation Realms > Foundation", "kb://vault/Lore/Cultivation Realms#Foundation"],
      ["Sects", "kb://vault/Lore/Sects"],
      ["map.png", "kb://vault/attachments/map.png"],
      ["Cultivation Realms", "kb://vault/Lore/Cultivation Realms"],
    ]);
    expect(links(converted.markdown).filter((link) => link.kind === "image")).toHaveLength(1);
    expect(converted.targets.size).toBe(5);
    expect(converted.findings[0].code).toBe("hidden_notes");
    expect(converted.findings.map((finding) => finding.code)).toContain("heading_not_followed");
    expect(converted.markdown).toContain("%%");
    expect(converted.markdown).toContain("==");
  });
  it("exports Chapter 1's callout and footnote lines byte-identical to the vault source", () => {
    const text = readFileSync(join(root, paths[0]), "utf8");
    const exportCodec = mdxCodec({ schema: buildDocumentSchema(), export: true });
    const blocks = codec.parse(convert(text).markdown).blocks;
    const exported = exportCodec.serialize(blocks, UNSCOPED_DOCUMENT_LINKS).split("\n");
    for (const line of [
      "> [!warning] A costly breakthrough",
      "> A cracked core cannot hold a second spirit.",
      "A debt can outlive a dynasty.[^debt]",
      "[^debt]: The Jade Crane Sect keeps its ledgers for seven generations.",
    ]) {
      expect(text.split("\n")).toContain(line);
      expect(exported).toContain(line);
    }
    expect(walkLinkOccurrences(codec.parse(exported.join("\n")).blocks)).toHaveLength(
      walkLinkOccurrences(blocks).length,
    );
  });
  it("converts relative Markdown destinations without losing labels, title or external links", () => {
    const result = convert(readFileSync(join(root, "Chapters/Ch 2.md"), "utf8"), selected[1]);
    expect(links(result.markdown).map((link) => [link.label, link.attrs.href])).toEqual([
      ["Chapter 1 - The Gate", "kb://vault/Chapters/Chapter 1 - The Gate"],
      ["the sect register", "kb://vault/Lore/Sects"],
      ["a clan ledger", "kb://vault/Chapters/Sects and Clans"],
      ["Chapter 1 - The Gate", "kb://vault/Chapters/Chapter 1 - The Gate"],
      ["Lin", "kb://vault/Characters/Lin Feng"],
    ]);
    expect(result.markdown).toContain("\n\n[Chapter 1 - The Gate]");
    expect(
      convert(
        '[**Lin**](<../Characters/Lin Feng.md> "title") [web](https://example.com)',
        selected[1],
      ).markdown,
    ).toContain('[**Lin**](<kb://vault/Characters/Lin Feng> "title")');
  });
  it("handles destinations with balanced parentheses, encoded names and titles", () => {
    const pool = [candidate("Chapters/Chapter (2).md"), selected[0]];
    const result = convert('[next](Chapter%20(2).md "kept")', selected[0], pool);
    expect(links(result.markdown).map((link) => link.attrs.href)).toEqual([
      "kb://vault/Chapters/Chapter (2)",
    ]);
    expect(result.markdown).toContain('"kept"');
  });
  it("leaves code and comments untouched; converts table links without destroying the table", () => {
    const text =
      "`[[Sects]]`\n\n```\n[[Sects]]\n```\n\n%% [[Sects]] %%\n\n<!-- [[Sects]] -->\n\n| Who |\n| --- |\n| [[Lin Feng\\|Lin]] |\n";
    const result = convert(text);
    expect(result.markdown).toContain("`[[Sects]]`");
    expect(result.markdown).toContain("%% [[Sects]] %%");
    expect(result.markdown).toContain("<!-- [[Sects]] -->");
    expect(links(result.markdown).map((link) => link.label)).toEqual(["Lin"]);
    expect(codec.parse(result.markdown).blocks.at(-1)?.type.name).toBe("table");
  });
  it("stores unreadable YAML, reports it, removes it and never interprets code properties", () => {
    const result = convert("---\naliases: [unterminated\n---\nBody");
    expect(result.properties).toEqual({ format: "yaml", text: "aliases: [unterminated\n" });
    expect(result.aliases).toEqual([]);
    expect(result.markdown).toBe("Body");
    expect(result.findings.map((finding) => finding.code)).toContain("properties_unreadable");
  });
  it.each([
    ["a list of names", "aliases: [Gate, 3, Old Wu]\n"],
    ["a single name", "aliases: Gate\n"],
    ["a tag the core schema does not know", "aliases: !custom [Tagged]\n"],
    [
      "101 references to one anchor",
      `base: &a A\naliases: [${Array(101).fill("*a").join(", ")}]\n`,
    ],
    [
      "nesting deeper than the display walks",
      `x: ${"[".repeat(40)}1${"]".repeat(40)}\naliases: [Deep]\n`,
    ],
    ["a cycle beside the aliases", "x: &x [*x]\naliases: [A]\n"],
    ["text over the size cap", `aliases: [Tail]\n#${" ".repeat(MAX_PROPERTIES_TEXT_LENGTH)}\n`],
  ])("reads %s exactly as the properties display does", (_name, yaml) => {
    const display = parseDocumentProperties({ format: "yaml", text: yaml });
    const imported = convert(`---\n${yaml}---\n[[Gate]]`);
    expect(imported.findings.some((finding) => finding.code === "properties_unreadable")).toBe(
      display.unreadable,
    );
    expect(imported.aliases).toEqual(display.aliases);
  });
  it("honors exact case, source folder, path depth, aliases, attachment folder and prose suffixes", () => {
    const result = convert(
      "[[Magic System]] [[magic system]] [[World Bible]] [[Little Crane|Crane]] [[Chapter 3 - Ash.txt]] ![[map.png|300]] [[Chapter 9]]",
    );
    expect([...result.targets.values()]).toContain("Chapters/Chapter 3 - Ash.txt");
    expect(
      links(result.markdown)
        .slice(0, 2)
        .map((link) => link.attrs.href),
    ).toEqual(["kb://vault/Lore/Magic System", "kb://vault/Lore/magic system"]);
    expect(result.findings.filter((finding) => finding.code === "link_via_alias")).toHaveLength(2);
    expect(result.findings.map((finding) => finding.code)).toContain("image_size_dropped");
    expect(links(result.markdown).at(-1)?.attrs.href).toBe("kb://vault/Chapter 9");
    const pool = [
      candidate("A/Budget.md"),
      candidate("B/Budget.md"),
      candidate("A/Holder.md"),
      candidate("attachments/map.png"),
      candidate("other/map.png"),
    ];
    const index = createLinkIndex(pool, []);
    expect(index.resolveLinkpath("Budget", pool[2])?.target.id).toBe("A/Budget.md");
    expect(index.resolveLinkpath("map.png", pool[2], "attachments", true)?.target.id).toBe(
      "attachments/map.png",
    );
  });
  it("selection wins; project fallback shares paste's path-qualified ranking and reports existing aliases", () => {
    const source = { ...candidate("Ch.md"), rootId: null, uri: "manuscript://Ch" };
    const existing = [
      candidate("Lore/Sects.md", [], "kb://Lore/Sects"),
      candidate("Archive/Lore/Sects.md", [], "manuscript://Archive/Lore/Sects"),
      candidate("World.md", ["World Bible"], "kb://Lore/World"),
    ];
    const result = convert("[[Lore/Sects]] [[World Bible]]", source, [source], existing);
    expect(links(result.markdown).map((link) => link.attrs.href)).toEqual([
      "kb://Lore/Sects",
      "kb://Lore/World",
    ]);
    expect(result.findings.filter((finding) => finding.code === "link_to_existing")).toHaveLength(
      2,
    );
    const own = candidate("Sects.md");
    own.rootId = null;
    expect(convert("[[Sects]]", source, [source, own], existing).targets.get(0)).toBe(own.id);
  });
  it("edits only destinations: a picture inside a link and a code-span label stay intact", () => {
    const image = convert("[![cover](../attachments/map.png)](../Lore/Sects.md) after");
    expect(image.markdown).toBe(
      "[![cover](kb://vault/attachments/map.png)](kb://vault/Lore/Sects) after",
    );
    // The schema has no linked pictures, so the picture is the only occurrence.
    expect(links(image.markdown).map((link) => [link.kind, link.attrs.href])).toEqual([
      ["image", "kb://vault/attachments/map.png"],
    ]);
    expect([...image.targets]).toEqual([[0, "attachments/map.png"]]);
    expect(convert("[`x](x`](../Lore/Sects.md) after").markdown).toBe(
      "[`x](x`](kb://vault/Lore/Sects) after",
    );
  });
  it("carries identity per occurrence, never through a shared or hand-written address", () => {
    const source = candidate("Holder.md");
    const a = { ...candidate("A/map.png"), uri: "kb://vault/B/map.png" };
    const b = candidate("B/map.png");
    const shared = convert("![[A/map.png]] ![[B/map.png]]", source, [source, a, b]);
    expect([...shared.targets]).toEqual([
      [0, "A/map.png"],
      [1, "B/map.png"],
    ]);
    // A link already spelled at the converted address is not the converted occurrence.
    const manual = convert("[manual](kb://vault/Lore/Sects) [[Sects]]");
    expect([...manual.targets]).toEqual([[1, "Lore/Sects.md"]]);
  });
  it("reports only path-segment matches as ambiguity candidates", () => {
    const source = { ...candidate("Ch.md"), rootId: null, uri: "manuscript://Ch" };
    const existing = [
      candidate("Sects.md", [], "kb://Sects"),
      candidate("FootSects.md", [], "kb://FootSects"),
    ];
    const result = convert("[[Sects]]", source, [source], existing);
    expect(result.targets.get(0)).toBe("Sects.md");
    expect(result.findings.map((finding) => finding.code)).not.toContain("link_ambiguous");
  });
});

describe("a folder's Obsidian settings", () => {
  const root = (fields: object) => ({
    rootId: 0,
    kind: "folder" as const,
    name: "vault",
    ...fields,
  });

  it("keeps why the browser sent none apart from settings that are not JSON", () => {
    expect(obsidianSettings(root({})).problem).toBeNull();
    expect(obsidianSettings(root({ appJson: '{"newFileLocation":"current"}' }))).toMatchObject({
      newFileLocation: "current",
      problem: null,
    });
    expect(obsidianSettings(root({ appJson: "{not json" })).problem).toBe("malformed");
    expect(obsidianSettings(root({ appJson: "[1]" })).problem).toBe("malformed");
    for (const unread of ["unavailable", "unreadable", "too_large"] as const)
      expect(obsidianSettings(root({ appJsonUnread: unread })).problem).toBe(unread);
  });
});
