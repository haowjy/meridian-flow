/** Fixture and boundary contracts for the shared Obsidian syntax scanner. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { markdownParser } from "../markdown-parse.js";
import { scanObsidian, splitObsidianFrontmatter } from "./index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8");

describe("fixture vault", () => {
  it("recognizes Chapter 1 without rewriting its text", () => {
    const input = fixture("Chapter 1 - The Gate");
    const { source, findings } = scanObsidian(input);
    expect(source).toBe(input);
    const frontmatter = findings.find((finding) => finding.kind === "frontmatter");
    expect(frontmatter?.text).toBe(
      "aliases: [Gate Opening, First Chapter]\ntags: [serial, progression-fantasy]\nstatus: revised\n",
    );
    const links = findings.filter((finding) => finding.kind === "wikilink");
    expect(
      links.map(({ linkpath, heading, block, label, embed }) => ({
        linkpath,
        heading,
        block,
        label,
        embed,
      })),
    ).toEqual([
      { linkpath: "Lin Feng", label: "the protagonist", heading: null, block: null, embed: false },
      {
        linkpath: "Cultivation Realms",
        label: null,
        heading: "Foundation",
        block: null,
        embed: false,
      },
      { linkpath: "Sects", label: null, heading: null, block: null, embed: false },
      { linkpath: "map.png", label: null, heading: null, block: null, embed: true },
      {
        linkpath: "Cultivation Realms",
        label: null,
        heading: null,
        block: "core-oath",
        embed: false,
      },
    ]);
    for (const kind of [
      "comment",
      "callout",
      "highlight",
      "tag",
      "footnoteReference",
      "footnoteDefinition",
    ])
      expect(
        findings.filter((finding) => finding.kind === kind),
        kind,
      ).toHaveLength(1);
    expect(findings.find((finding) => finding.kind === "callout")).toMatchObject({
      calloutType: "warning",
    });
    expect(findings.find((finding) => finding.kind === "tag")).toMatchObject({
      tag: "foreshadowing",
    });
    for (const link of links) expect(source.slice(link.from, link.to)).toMatch(/^!?\[\[.*\]\]$/);
  });

  it("recognizes Ch 2's note embed and ordinary Markdown links", () => {
    const { findings } = scanObsidian(fixture("Ch 2"));
    expect(
      findings.filter((finding) => finding.kind === "wikilink" && !finding.embed),
    ).toHaveLength(2);
    expect(findings.filter((finding) => finding.kind === "wikilink" && finding.embed)).toHaveLength(
      1,
    );
    expect(
      findings.filter((finding) => finding.kind === "markdownLink").map((finding) => finding.url),
    ).toEqual(["../Lore/Sects.md", "Sects%20and%20Clans.md"]);
    for (const kind of ["frontmatter", "comment", "callout", "highlight"])
      expect(
        findings.filter((finding) => finding.kind === kind),
        kind,
      ).toHaveLength(1);
  });
});

describe("syntax boundaries", () => {
  it.each([
    "%% secret %%",
    "<!-- secret -->",
  ])("keeps prose following inline comment %s", (comment) => {
    const { findings } = scanObsidian(comment + " [[Visible]] #tag ==highlight==");
    expect(findings.filter((finding) => finding.kind === "wikilink")).toMatchObject([
      { linkpath: "Visible" },
    ]);
    expect(findings.filter((finding) => finding.kind === "tag")).toMatchObject([{ tag: "tag" }]);
    expect(findings.filter((finding) => finding.kind === "highlight")).toMatchObject([
      { text: "highlight" },
    ]);
  });

  it("does not let a fence inside a comment hide later comment delimiters", () => {
    const { findings } = scanObsidian("%%\n```\n%%\n\n%% [[hidden]] %%\n\n[[real]]");
    expect(findings.filter((finding) => finding.kind === "comment")).toHaveLength(2);
    expect(findings.filter((finding) => finding.kind === "wikilink")).toMatchObject([
      { linkpath: "real" },
    ]);
  });

  it("never links or counts special syntax inside code and comments", () => {
    const input =
      "`[[span]] #tag ==no== %% code %%`\n\n~~~md\n[[fence]]\n<!-- code -->\n~~~\n\n%% [[inline]] %%\n\n%%\n[[block]]\n%%\n\n<!-- [[html]] -->\n\n[[real]]";
    const { findings } = scanObsidian(input);
    expect(findings.filter((finding) => finding.kind === "wikilink")).toMatchObject([
      { linkpath: "real" },
    ]);
    expect(findings.filter((finding) => finding.kind === "comment")).toHaveLength(3);
    expect(
      findings.filter((finding) => finding.kind === "tag" || finding.kind === "highlight"),
    ).toEqual([]);
  });

  it("keeps escaped aliases in table cells and the mdast table intact", () => {
    const input = "| Who |\n| --- |\n| [[Lin Feng\\|Lin]] |";
    const result = scanObsidian(input);
    expect(result.source).toBe(input);
    expect(result.findings).toMatchObject([
      { kind: "wikilink", linkpath: "Lin Feng", label: "Lin" },
    ]);
    expect(markdownParser().parse(result.source)).toMatchObject({ children: [{ type: "table" }] });
    const link = result.findings[0];
    expect(input.slice(link?.from, link?.to)).toBe("[[Lin Feng\\|Lin]]");
  });

  it("reports sizes only on embeds and preserves local heading/block targets", () => {
    expect(
      scanObsidian("![[map.png|300]] ![[map.png|300x200]] [[A|300]] [[#Heading]] [[#^block]]")
        .findings,
    ).toMatchObject([
      { embed: true, size: { width: 300, height: null }, label: null },
      { embed: true, size: { width: 300, height: 200 }, label: null },
      { embed: false, label: "300", size: null },
      { linkpath: "", heading: "Heading" },
      { linkpath: "", block: "block" },
    ]);
  });

  it("reports escapes even when unclosed, but ignores escaped links and code", () => {
    expect(scanObsidian("\\[[A]] \\[\\[B]] \\[[ `\\[[C]]` [[D]]").findings).toMatchObject([
      { kind: "escape", literal: "[[" },
      { kind: "escape", literal: "[[" },
      { kind: "escape", literal: "[[" },
      { kind: "wikilink", linkpath: "D" },
    ]);
    expect(scanObsidian("\\\\[[A]]").findings).toMatchObject([{ kind: "wikilink", linkpath: "A" }]);
  });

  it("does not find tags in headings, URLs, destinations, code, or wikilinks", () => {
    expect(
      scanObsidian(
        "# Heading\nhttps://example.com/#url [x](https://x/#dest) `#code` [[A#Heading]] #real #nested/tag #123",
      ).findings.filter((finding) => finding.kind === "tag"),
    ).toMatchObject([{ tag: "real" }, { tag: "nested/tag" }]);
  });

  it("uses preprocessed-source offsets after continued table rows", () => {
    const input = "| A |\n| --- |\n| first\\\nsecond |\n\n[[After]]";
    const { source, findings } = scanObsidian(input);
    expect(source).toContain("first<br/>second");
    const link = findings.find((finding) => finding.kind === "wikilink");
    expect(link?.from).toBe(source.indexOf("[[After]]"));
    expect(source.slice(link?.from, link?.to)).toBe("[[After]]");
  });

  it("keeps already-parsed paste text and its offsets without repeating ingress", () => {
    const text = "| A |\n| --- |\n| first\\\nsecond |\n\n[[After]]";
    const { source, findings } = scanObsidian(text, { preprocessed: true });
    expect(source).toBe(text);
    expect(findings.find((finding) => finding.kind === "wikilink")?.from).toBe(
      text.indexOf("[[After]]"),
    );
  });

  it("reports unclosed comments through EOF without leaking their links", () => {
    expect(scanObsidian("%% [[hidden]]").findings).toEqual([
      { kind: "comment", syntax: "obsidian", from: 0, to: 13 },
    ]);
    expect(scanObsidian("<!-- [[hidden]]").findings).toHaveLength(1);
  });

  it("reports callout folding and footnote definitions with continuation text", () => {
    const { source, findings } = scanObsidian(
      "> [!tip]- Title\n> Body\n\nText[^x].\n\n[^x]: First\n    second\n",
    );
    expect(findings.find((finding) => finding.kind === "callout")).toMatchObject({
      calloutType: "tip",
      fold: "-",
    });
    const definition = findings.find((finding) => finding.kind === "footnoteDefinition");
    expect(source.slice(definition?.from, definition?.to)).toContain("second");
    expect(findings.filter((finding) => finding.kind === "footnoteReference")).toHaveLength(1);
  });
});

describe("raw frontmatter", () => {
  it("preserves BOM, CRLF, invalid YAML and exact body bytes", () => {
    const raw = "\uFEFF---\r\nbroken: [\r\n---\r\nBody\r\n";
    expect(splitObsidianFrontmatter(raw)).toEqual({
      frontmatter: { kind: "frontmatter", from: 0, to: raw.indexOf("Body"), text: "broken: [\r\n" },
      body: "Body\r\n",
    });
    expect(splitObsidianFrontmatter("---\n---").frontmatter?.text).toBe("");
  });

  it("requires a leading, closed delimiter block", () => {
    for (const input of ["---\nnot closed", "text\n---\na: b\n---\n", "---", " ---\na: b\n---\n"])
      expect(splitObsidianFrontmatter(input)).toEqual({ frontmatter: null, body: input });
  });
});
