/** Stored frontmatter parses for display in source order, or is reported unreadable. */
import { describe, expect, it } from "vitest";
import { parseDocumentProperties } from "./document-properties.js";
import { MAX_PROPERTIES_TEXT_LENGTH } from "./frontmatter.js";

const parse = (text: string) => parseDocumentProperties({ format: "yaml", text });

describe("parseDocumentProperties", () => {
  it("keeps keys in source order, including keys that look like integers", () => {
    const { entries } = parse("status: revised\n10: ten\naliases: [Gate]\n2: two\n");
    expect(entries.map((entry) => entry.key)).toEqual(["status", "10", "aliases", "2"]);
  });

  it("reads lists, nested maps, booleans, null and dates as written", () => {
    const { entries, unreadable } = parse(
      "tags: [a, b]\nsources:\n  - book: Ashfall\n    page: 12\ndraft: true\nnotes:\ndate: 2025-01-02\n",
    );
    expect(unreadable).toBe(false);
    expect(entries).toEqual([
      { key: "tags", value: ["a", "b"], source: "[a, b]" },
      {
        key: "sources",
        value: [{ book: "Ashfall", page: 12 }],
        source: "- book: Ashfall\n  page: 12",
      },
      { key: "draft", value: true, source: null },
      { key: "notes", value: null, source: null },
      { key: "date", value: "2025-01-02", source: null },
    ]);
  });

  it("derives aliases from a list or a single name and ignores other shapes", () => {
    expect(parse("aliases: [Old Wu, 3, The Young Master]\n").aliases).toEqual([
      "Old Wu",
      "The Young Master",
    ]);
    expect(parse("aliases: Old Wu\n").aliases).toEqual(["Old Wu"]);
    expect(parse("aliases: {a: b}\n").aliases).toEqual([]);
  });

  it("sends numbers JSON cannot carry as text", () => {
    expect(parse("x: .inf\n").entries).toEqual([{ key: "x", value: "Infinity", source: null }]);
  });

  it("reads comment-only frontmatter as no keys", () => {
    expect(parse("# nothing here\n")).toMatchObject({ entries: [], unreadable: false });
  });

  it.each([
    ["a syntax error", "key: [unclosed\n"],
    ["duplicate keys", "a: 1\na: 2\n"],
    ["a top-level list", "- a\n- b\n"],
    ["a bare scalar", "just words\n"],
  ])("reports %s as unreadable, with the text unchanged", (_name, text) => {
    expect(parse(text)).toEqual({
      entries: [],
      aliases: [],
      unreadable: true,
      truncated: false,
      text,
    });
  });
});

describe("the source shown for list and map values", () => {
  const sources = (text: string) => parse(text).entries.map((entry) => entry.source);

  it("is the writer's own text: quoted keys, comment-like and numeric-looking strings stay as typed", () => {
    const text = [
      "meta:",
      '  "a: b": x',
      '  "# not a comment": 2',
      '  note: "abc #def"',
      '  sci: "1e3"',
      '  hex: "0x10"',
      '  colon: "abc:"',
      "",
    ].join("\n");
    expect(sources(text)).toEqual([
      text
        .split("\n")
        .slice(1, -1)
        .map((line) => line.slice(2))
        .join("\n"),
    ]);
  });

  it("keeps the comments and blank lines inside the value, and drops the block's indent", () => {
    expect(
      sources("sources:\n  - book: Ashfall # first\n    page: 12\n\n  - book: Cinders\nnext: 1\n"),
    ).toEqual(["- book: Ashfall # first\n  page: 12\n\n- book: Cinders", null]);
  });

  it("keeps a flow value as it sits after its key", () => {
    expect(sources("origin: {sect: Outer, rank: 3}\n")).toEqual(["{sect: Outer, rank: 3}"]);
  });

  it("shows an alias's value as the text where it was written", () => {
    expect(sources("base: &b\n  - a: 1\nref: *b\n")).toEqual(["- a: 1", "- a: 1"]);
  });

  it("is null for words, numbers, flags, null and empty containers", () => {
    expect(sources("a: word\nb: 2\nc: true\nd:\ne: []\nf: {}\n")).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("hostile frontmatter", () => {
  const expectUnreadable = (text: string) =>
    expect(parse(text)).toMatchObject({ entries: [], unreadable: true, text });

  it("shows a self-referencing alias as written instead of failing", () => {
    expectUnreadable("x: &x [*x]\n");
    expectUnreadable("x: &x {a: *x}\n");
  });

  it("stops an expanding alias at the budget instead of expanding it", () => {
    let text = "l0: &l0 [x, x, x, x, x, x, x, x, x, x]\n";
    for (let level = 1; level <= 6; level += 1) {
      text += `l${level}: &l${level} [${Array(10)
        .fill(`*l${level - 1}`)
        .join(", ")}]\n`;
    }
    expect(text.length).toBeLessThan(MAX_PROPERTIES_TEXT_LENGTH);
    expectUnreadable(text);
  });

  it("allows an alias reused side by side, which is not a cycle", () => {
    expect(parse("a: &a [1, 2]\nb: [*a, *a]\n")).toMatchObject({ unreadable: false });
  });

  it("shows a tag the core schema does not know as written, since reading it would drop its meaning", () => {
    expectUnreadable("x: !foo bar\n");
  });

  it("shows nesting deeper than it will walk as written", () => {
    expectUnreadable(`x: ${"[".repeat(2000)}1${"]".repeat(2000)}`);
    expectUnreadable(`x: ${"[".repeat(40)}1${"]".repeat(40)}`);
  });

  it("shows a key it cannot name as written", () => {
    expectUnreadable("? [a, b]\n: c\n");
    expectUnreadable("~: c\n");
  });

  it("does not parse frontmatter over the size cap, and sends only its start with a flag", () => {
    const text = Array.from({ length: 20_000 }, (_, index) => `key${index}: value`).join("\n");
    const started = performance.now();
    const result = parse(text);
    expect(performance.now() - started).toBeLessThan(100);
    expect(result).toMatchObject({ entries: [], aliases: [], unreadable: true, truncated: true });
    expect(result.text.length).toBeLessThanOrEqual(MAX_PROPERTIES_TEXT_LENGTH);
    expect(text.startsWith(result.text)).toBe(true);
    expect(result.text.endsWith("\n")).toBe(false);
  });

  it("parses frontmatter right at the cap in well under a second", () => {
    const text = Array.from({ length: 2_000 }, (_, index) => `key${index}: value`).join("\n");
    const padded = `${text}\n#${" ".repeat(MAX_PROPERTIES_TEXT_LENGTH - text.length - 2)}`;
    expect(padded.length).toBe(MAX_PROPERTIES_TEXT_LENGTH);
    const started = performance.now();
    expect(parse(padded)).toMatchObject({ unreadable: false });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
