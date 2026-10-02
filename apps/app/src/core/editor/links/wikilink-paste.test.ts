/** Pasted `[[Name]]`: Obsidian's syntax, its resolution order, and the slice it becomes. */
import { getSchema } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { linkAheadAddress } from "./link-address";
import {
  linkPastedWikilinks,
  parseWikilinks,
  pickWikilinkTarget,
  type WikilinkPasteCatalog,
  wikilinkHref,
} from "./wikilink-paste";

const bare = (name: string) => ({ folders: [], name });

describe("parseWikilinks", () => {
  it("reads every Obsidian form", () => {
    const text =
      "[[Lin Feng]] [[chapter-1|the opening]] [[Kael#The Duel]] [[Kael#^b1]] [[Arc 1/Kael.md]]";
    expect(
      parseWikilinks(text).map(({ target, suffix, label }) => ({ target, suffix, label })),
    ).toEqual([
      { target: bare("Lin Feng"), suffix: "", label: "Lin Feng" },
      { target: bare("chapter-1"), suffix: "", label: "the opening" },
      { target: bare("Kael"), suffix: "#The Duel", label: "Kael" },
      { target: bare("Kael"), suffix: "#^b1", label: "Kael" },
      { target: { folders: ["Arc 1"], name: "Kael.md" }, suffix: "", label: "Kael" },
    ]);
  });

  it("reports the exact source range", () => {
    expect(parseWikilinks("See [[Gate]].")).toMatchObject([{ from: 4, to: 12 }]);
  });

  it("reads a table's escaped alias bar", () => {
    expect(parseWikilinks("[[Gate\\|the gate]]")).toMatchObject([
      { target: bare("Gate"), label: "the gate" },
    ]);
  });

  it("leaves a link inside a code span the text still spells", () => {
    expect(
      parseWikilinks("`[[code]]` and ``a ` [[b]]`` then [[c]]").map(({ label }) => label),
    ).toEqual(["c"]);
    expect(parseWikilinks("an unclosed ` before [[c]]").map(({ label }) => label)).toEqual(["c"]);
  });

  it("leaves embeds, escapes, and empty or malformed targets", () => {
    for (const text of [
      "![[map.png]]",
      "\\[[Gate]]",
      "[[]]",
      "[[#Heading]]",
      "[[a//b]]",
      "[[a\nb]]",
    ])
      expect(parseWikilinks(text)).toEqual([]);
  });
});

describe("pickWikilinkTarget", () => {
  const holder = "manuscript://volume-1/chapter-2.md";

  it("prefers the holder's folder, then its area root, then a deeper one", () => {
    const deeper = "manuscript://notes/old/Gate.md";
    const root = "manuscript://Gate.md";
    const sibling = "manuscript://volume-1/Gate.md";
    expect(pickWikilinkTarget([deeper, root, sibling], bare("Gate"), holder)).toBe(sibling);
    expect(pickWikilinkTarget([deeper, root], bare("Gate"), holder)).toBe(root);
  });

  it("prefers the holder's area over another area", () => {
    expect(
      pickWikilinkTarget(["kb://Gate.md", "manuscript://notes/deep/Gate.md"], bare("Gate"), holder),
    ).toBe("manuscript://notes/deep/Gate.md");
  });

  it("orders equal depths alphabetically by URI, so the pick never depends on index order", () => {
    const candidates = ["kb://places/Gate.md", "kb://lore/Gate.md"];
    expect(pickWikilinkTarget(candidates, bare("Gate"), holder)).toBe("kb://lore/Gate.md");
    expect(pickWikilinkTarget([...candidates].reverse(), bare("Gate"), holder)).toBe(
      "kb://lore/Gate.md",
    );
  });

  it("reads a folder form exactly from the holder's area root, then another area's, before a suffix", () => {
    const target = { folders: ["places"], name: "Gate" };
    const suffix = "manuscript://old/places/Gate.md";
    const kbExact = "kb://places/Gate.md";
    const userExact = "user://places/Gate.md";
    const own = "manuscript://places/Gate.md";
    expect(pickWikilinkTarget([suffix, kbExact, userExact, own], target, holder)).toBe(own);
    expect(pickWikilinkTarget([suffix, userExact, kbExact], target, holder)).toBe(kbExact);
    expect(pickWikilinkTarget([suffix], target, holder)).toBe(suffix);
  });

  it("ignores case and implies `.md`", () => {
    expect(pickWikilinkTarget(["kb://characters/Lin Feng.md"], bare("lin feng"), holder)).toBe(
      "kb://characters/Lin Feng.md",
    );
    expect(pickWikilinkTarget(["kb://maps/map.png"], bare("Map.PNG"), holder)).toBe(
      "kb://maps/map.png",
    );
    expect(pickWikilinkTarget(["kb://Gate.md"], bare("Gates"), holder)).toBeNull();
  });

  it("ranks without a holder address", () => {
    expect(pickWikilinkTarget(["kb://a/b/Gate.md", "user://Gate.md"], bare("Gate"), null)).toBe(
      "user://Gate.md",
    );
  });
});

describe("wikilinkHref", () => {
  const catalog = (holderUri: string | null, targets: string[]): WikilinkPasteCatalog => ({
    holderUri,
    targets,
    linkAhead: (name, folders) => {
      const uri = linkAheadAddress(holderUri, name, folders);
      return uri ? { uri } : null;
    },
  });
  const occurrence = (text: string) => {
    const [found] = parseWikilinks(text);
    if (!found) throw new Error(`No wikilink in ${text}`);
    return found;
  };
  const lin = occurrence("[[Lin Feng#Past]]");
  const kael = occurrence("[[Kael]]");
  const path = occurrence("[[Arc 1/Kael]]");

  it("spells a match from the holder: relative within its area, a full URI across", () => {
    const targets = ["kb://characters/Lin Feng.md", "manuscript://volume-1/Kael.md"];
    expect(wikilinkHref(lin, catalog("manuscript://volume-1/chapter-2.md", targets))).toBe(
      "kb://characters/Lin Feng.md#Past",
    );
    expect(wikilinkHref(lin, catalog("kb://places/Gate.md", targets))).toBe(
      "../characters/Lin Feng.md#Past",
    );
    expect(wikilinkHref(kael, catalog("manuscript://volume-1/chapter-2.md", targets))).toBe(
      "Kael.md",
    );
  });

  it("links a name no document has beside the holder, and a path from its area root", () => {
    const holder = "manuscript://volume-1/chapter-2.md";
    expect(wikilinkHref(kael, catalog(holder, []))).toBe("Kael.md");
    expect(wikilinkHref(path, catalog(holder, []))).toBe("../Arc 1/Kael.md");
    expect(wikilinkHref(path, catalog(null, []))).toBe("manuscript://Arc 1/Kael.md");
  });
});

describe("linkPastedWikilinks", () => {
  const schema = getSchema(createStandaloneEditorExtensions());
  const catalog: WikilinkPasteCatalog = {
    holderUri: "manuscript://volume-1/chapter-2.md",
    targets: ["kb://characters/Lin Feng.md"],
    linkAhead: (name, folders) => {
      const uri = linkAheadAddress("manuscript://volume-1/chapter-2.md", name, folders);
      return uri ? { uri } : null;
    },
  };
  const paragraph = (...content: Parameters<typeof schema.text>[]) =>
    schema.nodes.paragraph.create(
      null,
      content.map(([text, marks]) => schema.text(text, marks)),
    );

  it("links prose and leaves code, embeds, and existing links", () => {
    const slice = new Slice(
      Fragment.from([
        paragraph(
          ["Meet [[Lin Feng]] by ![[map.png]] and "],
          ["[[code]]", [schema.marks.code.create()]],
          [" or "],
          ["[[linked]]", [schema.marks.link.create({ href: "https://example.com" })]],
        ),
        schema.nodes.code_block.create(null, schema.text("[[fenced]]")),
      ]),
      0,
      0,
    );
    const out = linkPastedWikilinks(slice, schema, catalog);
    const first = out.content.child(0);
    expect(first.textContent).toBe("Meet Lin Feng by ![[map.png]] and [[code]] or [[linked]]");
    expect(first.child(1).marks.map((mark) => mark.attrs.href)).toEqual([
      "kb://characters/Lin Feng.md",
    ]);
    expect(out.content.child(1).textContent).toBe("[[fenced]]");
  });

  it("returns the very slice when nothing converts", () => {
    const slice = new Slice(Fragment.from(paragraph(["no links here"])), 0, 0);
    expect(linkPastedWikilinks(slice, schema, catalog)).toBe(slice);
  });
});
