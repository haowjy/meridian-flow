/**
 * The one ranking, exercised where every trigger will meet it.
 *
 * These are the rules a second implementation would quietly get wrong: which
 * part of a name a writer is assumed to recall, how far behind an alias sits,
 * what `scope` withholds, and the two rows that are not simply matches — the
 * ambiguous document and the document nobody has written yet.
 */
import { describe, expect, it } from "vitest";

import {
  filterReferenceItems,
  type ReferenceCandidate,
  type ReferenceKind,
} from "./reference-catalog";

const DOCUMENTS: ReferenceKind[] = ["document"];
const EVERYTHING: ReferenceKind[] = ["document", "asset"];

function document(title: string, aliases?: readonly string[]): ReferenceCandidate {
  return {
    kind: "document",
    title,
    location: "Chapters",
    documentId: `document-${title}`,
    uri: `manuscript://${title}.md`,
    aliases,
  };
}

function asset(name: string): ReferenceCandidate {
  return {
    kind: "asset",
    name,
    location: "Assets",
    assetDocumentId: `asset-${name}`,
    path: `/assets/${name}`,
    fileType: "image",
    uri: `manuscript://assets/${name}`,
  };
}

const names = (items: readonly { name: string }[]) => items.map((item) => item.name);

describe("filterReferenceItems ranking", () => {
  it("puts how a name starts ahead of a word inside it ahead of anywhere at all", () => {
    const items = filterReferenceItems(
      [document("Floodgate Records"), document("The Third Gate"), document("Gatehouse")],
      DOCUMENTS,
      "gate",
    );

    expect(names(items)).toEqual([
      "Gatehouse",
      "The Third Gate",
      "Floodgate Records",
      // The row for the chapter nobody has written yet.
      "gate",
    ]);
  });

  it("holds the order the host handed them in when two names match equally", () => {
    const items = filterReferenceItems(
      [document("Gate One"), document("Gate Two"), document("Gate Three")],
      DOCUMENTS,
      "gate",
    );

    expect(names(items).slice(0, 3)).toEqual(["Gate One", "Gate Two", "Gate Three"]);
  });

  it("ranks an alias half a step behind the title it stands in for", () => {
    const items = filterReferenceItems(
      [
        document("Stewardens"),
        document("Ilsever", ["The Warden"]),
        document("The Warden's Ledger"),
      ],
      DOCUMENTS,
      "warden",
    );

    expect(items).toMatchObject([
      { name: "The Warden's Ledger", matchedAlias: null },
      { name: "Ilsever", matchedAlias: "The Warden" },
      { name: "Stewardens", matchedAlias: null },
      { kind: "create" },
    ]);
  });

  it("offers every candidate for an empty query, and no create row", () => {
    const items = filterReferenceItems([document("Gate One"), document("Gate Two")], DOCUMENTS, "");

    expect(names(items)).toEqual(["Gate One", "Gate Two"]);
  });

  it("drops a query no menu could have been asked in good faith", () => {
    expect(filterReferenceItems([document("Gate")], DOCUMENTS, "g".repeat(81))).toEqual([]);
  });

  it("stops at twenty rows, and still offers to create past them", () => {
    const many = Array.from({ length: 30 }, (_, index) => document(`Gate ${index}`));
    const items = filterReferenceItems(many, DOCUMENTS, "gate");

    expect(items).toHaveLength(21);
    expect(items.at(-1)).toMatchObject({ kind: "create", name: "gate" });
  });

  it("keeps pictures in reach while the writer browses a document-heavy project", () => {
    const many = [
      ...Array.from({ length: 22 }, (_, index) => document(`Chapter ${index + 1}`)),
      asset("map.png"),
      asset("gate.png"),
      asset("keep.png"),
      asset("crest.png"),
    ];
    const items = filterReferenceItems(many, EVERYTHING, "");

    expect(items).toHaveLength(20);
    expect(items.filter((item) => item.kind === "document")).toHaveLength(16);
    expect(names(items.filter((item) => item.kind === "asset"))).toEqual([
      "map.png",
      "gate.png",
      "keep.png",
      "crest.png",
    ]);
    // Documents still lead, in the order the manuscript reads in.
    expect(items[0]).toMatchObject({ kind: "document", name: "Chapter 1" });
  });

  it("lets pictures fill a browse the documents cannot", () => {
    const many = [
      ...Array.from({ length: 3 }, (_, index) => document(`Chapter ${index + 1}`)),
      ...Array.from({ length: 30 }, (_, index) => asset(`figure-${index + 1}.png`)),
    ];
    const items = filterReferenceItems(many, EVERYTHING, "");

    expect(items).toHaveLength(20);
    expect(items.filter((item) => item.kind === "document")).toHaveLength(3);
    expect(items.filter((item) => item.kind === "asset")).toHaveLength(17);
  });

  it("changes nothing about a browse the cap never touched", () => {
    const few = [document("Gate One"), document("Gate Two"), asset("map.png")];

    expect(names(filterReferenceItems(few, EVERYTHING, ""))).toEqual([
      "Gate One",
      "Gate Two",
      "map.png",
    ]);
  });

  it("lets a typed query spend the whole cap on the best matches, whatever their kind", () => {
    const many = [
      ...Array.from({ length: 22 }, (_, index) => document(`Gate ${index + 1}`)),
      asset("map.png"),
    ];
    const items = filterReferenceItems(many, EVERYTHING, "gate");

    // Every ranked row is a document: fit decides, the browse floor does not.
    expect(items.filter((item) => item.kind === "asset")).toHaveLength(0);
    expect(items).toHaveLength(21);
    expect(items.at(-1)).toMatchObject({ kind: "create", name: "gate" });
  });
});

describe("filterReferenceItems ambiguity", () => {
  it("marks both documents that answer to one name", () => {
    const items = filterReferenceItems(
      [document("Notes"), document("Gate"), document("Notes")],
      DOCUMENTS,
      "notes",
    );

    expect(items).toMatchObject([
      { name: "Notes", ambiguous: true },
      { name: "Notes", ambiguous: true },
    ]);
  });

  it("does not call a document ambiguous because an asset shares its name", () => {
    const items = filterReferenceItems([document("Map"), asset("Map")], EVERYTHING, "map");

    expect(items).toMatchObject([
      { kind: "document", name: "Map", ambiguous: false },
      { kind: "asset", name: "Map" },
    ]);
  });
});

describe("filterReferenceItems create row", () => {
  it("steps aside for a document that already carries the name", () => {
    const items = filterReferenceItems([document("The Third Gate")], DOCUMENTS, "the third gate");

    expect(items).toMatchObject([{ kind: "document" }]);
  });

  it("is offered when the name only appears inside an existing title", () => {
    const items = filterReferenceItems([document("The Third Gate")], DOCUMENTS, "third");

    expect(items).toMatchObject([{ kind: "document" }, { kind: "create", name: "third" }]);
  });

  it("is withheld when the scope cannot make a document", () => {
    const items = filterReferenceItems([asset("map.png")], ["asset"], "map");

    expect(items).toMatchObject([{ kind: "asset", name: "map.png" }]);
  });

  it("is offered even when an asset already carries the name exactly", () => {
    const items = filterReferenceItems([asset("Map")], EVERYTHING, "Map");

    expect(items).toMatchObject([{ kind: "asset" }, { kind: "create", name: "Map" }]);
  });
});

describe("filterReferenceItems scope", () => {
  it("withholds every kind the trigger did not ask for", () => {
    const candidates = [document("Map of the Pale"), asset("map.png")];

    expect(names(filterReferenceItems(candidates, DOCUMENTS, "map"))).toEqual([
      "Map of the Pale",
      "map",
    ]);
    expect(names(filterReferenceItems(candidates, ["asset"], "map"))).toEqual(["map.png"]);
  });

  it("puts a document above an asset that matched exactly as well", () => {
    const items = filterReferenceItems([asset("map.png"), document("Map")], EVERYTHING, "map");

    expect(items).toMatchObject([
      { kind: "document", name: "Map" },
      { kind: "asset", name: "map.png" },
    ]);
  });

  it("still lets a better-matching asset outrank a document", () => {
    const items = filterReferenceItems(
      [document("The Old Map"), asset("map.png")],
      EVERYTHING,
      "map",
    );

    expect(items).toMatchObject([
      { kind: "asset", name: "map.png" },
      { kind: "document", name: "The Old Map" },
      { kind: "create", name: "map" },
    ]);
  });

  it("carries the document's identity onto its row", () => {
    // The composer picks a row and has to be able to name the exact document
    // when the title is shared; asking the tree a second time to find out
    // which one is what this field spares it.
    const [item] = filterReferenceItems([document("Map of the Pale")], DOCUMENTS, "map");

    expect(item).toMatchObject({
      kind: "document",
      name: "Map of the Pale",
      documentId: "document-Map of the Pale",
      uri: "manuscript://Map of the Pale.md",
    });
  });

  it("carries the asset's identity onto its row", () => {
    const [item] = filterReferenceItems([asset("map.png")], EVERYTHING, "map");

    expect(item).toMatchObject({
      kind: "asset",
      name: "map.png",
      location: "Assets",
      assetDocumentId: "asset-map.png",
      path: "/assets/map.png",
    });
  });
});
