/** Stored frontmatter parses for display in source order, or is reported unreadable. */
import { describe, expect, it } from "vitest";
import { parseDocumentProperties } from "./document-properties.js";

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
      { key: "tags", value: ["a", "b"] },
      { key: "sources", value: [{ book: "Ashfall", page: 12 }] },
      { key: "draft", value: true },
      { key: "notes", value: null },
      { key: "date", value: "2025-01-02" },
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
    expect(parse("x: .inf\n").entries).toEqual([{ key: "x", value: "Infinity" }]);
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
    expect(parse(text)).toEqual({ entries: [], aliases: [], unreadable: true, text });
  });
});
