/** Exact presentation provenance must never alter the canonical stored document. */
import { describe, expect, it } from "vitest";
import { schema } from "./codec-test-support.js";
import { markdownCodec, UNSCOPED_DOCUMENT_LINKS } from "./index.js";

const codec = markdownCodec({ schema });
const parse = (source: string) => codec.parseWithSourceMap(source);
const ranges = (source: string, kind = "text") =>
  parse(source)
    .sourceMap.filter((run) => run.kind === kind)
    .map((run) => run.source && source.slice(run.source.from, run.source.to));

describe("presentation source map", () => {
  it("maps plain text and mark-split text to original offsets", () => {
    expect(ranges("first **bold** last")).toEqual(["first ", "bold", " last"]);
    expect(ranges("plain")).toEqual(["plain"]);
    expect(ranges("**intro**__/outline__")).toEqual(["intro", "/outline"]);
    expect(parse("**intro**__/outline__").sourceMap.map((run) => run.at.offset)).toEqual([0, 5]);
  });
  it("maps a mixed-format link as one complete source run", () => {
    const source = "[**chapter** one](manuscript://one.md)";
    const map = parse(source).sourceMap;
    expect(ranges(source, "link")).toEqual([source]);
    expect(map.find((run) => run.kind === "link")?.at.count).toBe(2);
    expect(ranges(source)).toEqual(["chapter", " one"]);
  });
  it("preserves escape/entity source bytes rather than displayed offsets", () => {
    expect(ranges("\\* &amp; /outline")).toEqual(["\\* &amp; /outline"]);
  });
  it("maps angle autolinks, but bare URLs stay text", () => {
    expect(ranges("<https://example.com>", "link")).toEqual(["<https://example.com>"]);
    expect(ranges("https://example.com", "link")).toEqual([]);
  });
  it("retains soft newlines for presentation breaks and maps hard-break neighbors", () => {
    expect(ranges("first\nsecond")).toEqual(["first\nsecond"]);
    expect(ranges("first  \nsecond")).toEqual(["first", "second"]);
  });
  it("excludes inline code and makes tables and rewritten documents unmappable", () => {
    expect(ranges("plain `code` tail")).toEqual(["plain ", null, " tail"]);
    expect(ranges("> first\n> /outline tail")).toEqual([null]);
    expect(ranges("first\r\n/outline")).toEqual(["first\r\n/outline"]);
    expect(
      parse("| A |\n| --- |\n| /outline |").sourceMap.every((run) => run.source === null),
    ).toBe(true);
    expect(parse("```ts\n/outline\n```").sourceMap).toEqual([]);
  });
  it("keeps ordinary parsing byte-identical and preserves the drift sample round trip", () => {
    const sample =
      "## The Ninth Gate\n\nLin Feng stepped through the gate. The **elder** watched, *silent*, while `qi` pooled in his palms. See [the cultivation ladder](https://example.com/ladder).\n\n### Realms so far\n\n- Qi Condensation\n  - Nine layers, each a wall\n- Foundation Establishment\n- Core Formation\n\n1. Break the seal\n2. Survive the backlash\n3. Tell no one\n\n> The heavens do not forgive debts. They only collect them.\n\n| Realm | Lifespan | Rank |\n|:--|--:|:-:|\n| Qi Condensation | 120 | F |\n| Foundation | 250 | D |\n\n```ts\nconst breakthrough = (qi: number) => qi > 9000;\n```\n\n---\n\nThe gate closed behind him.\n";
    const ordinary = codec.parse(sample).blocks;
    const mapped = parse(sample).blocks;
    expect(JSON.stringify(mapped.map((node) => node.toJSON()))).toBe(
      JSON.stringify(ordinary.map((node) => node.toJSON())),
    );
    const serialized = codec.serialize(ordinary, UNSCOPED_DOCUMENT_LINKS);
    expect(parse(serialized).blocks.map((node) => node.toJSON())).toEqual(
      codec.parse(serialized).blocks.map((node) => node.toJSON()),
    );
    expect(codec.serialize(mapped, UNSCOPED_DOCUMENT_LINKS)).toBe(serialized);
  });
});
