/** Stored-link resolution and spelling rules, and written-link classification.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Lineage link spelling policy (kb/decisions/documents/identity/link-identity.md)
 */
import { expect, it } from "vitest";
import {
  type CatalogDocument,
  classifyWrittenLink,
  classifyWrittenSource,
  type LinkCatalog,
  type LinkHolder,
  resolveStoredLink,
  spellStoredLink,
  storedHref,
} from "./document-link.js";
import { aheadAddress, isAheadFilename, parseLinkRef } from "./document-ref.js";

// UUID-shaped ids: refs are UUID-backed, and anything else is malformed.
const names = [
  "sibling",
  "cast",
  "drafted",
  "deleted",
  "secret",
  "foreign",
  "picture",
  "occupant",
  "unknown",
  "neverLoaded",
  "settled",
  "settledGone",
  "open",
  "unregistered",
] as const;
const U = Object.fromEntries(
  names.map((name, index) => [
    name,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ]),
) as Record<(typeof names)[number], string>;

const doc = (documentId: string, uri: string, extra: Partial<CatalogDocument> = {}) => ({
  documentId,
  owner: { workId: null },
  projectId: "p1",
  uri,
  presence: "live" as const,
  readable: true,
  nameable: true,
  ...extra,
});
const documents: Record<string, CatalogDocument | null> = {
  [U.sibling]: doc(U.sibling, "manuscript://book/ch2"),
  [U.cast]: doc(U.cast, "kb://cast/Lin Feng"),
  [U.drafted]: doc(U.drafted, "manuscript://book/new", { presence: "branch" }),
  [U.deleted]: doc(U.deleted, "manuscript://book/old", { presence: "deleted" }),
  [U.secret]: doc(U.secret, "manuscript://book/secret", { readable: false }),
  [U.foreign]: doc(U.foreign, "manuscript://theirs", { projectId: "p2", nameable: false }),
  [U.picture]: doc(U.picture, "manuscript://assets/gate.png"),
  [U.occupant]: doc(U.occupant, "manuscript://book/arrived"),
  [U.unknown]: null,
};
const settlements: Record<string, string | null> = {
  [U.settled]: U.cast,
  [U.settledGone]: U.deleted,
  [U.open]: null,
};
const addresses: Record<string, CatalogDocument | null | undefined> = {
  "manuscript://book/arrived": documents[U.occupant],
  "manuscript://book/secret": documents[U.secret],
  "manuscript://book/unloaded": undefined,
};
const catalog: LinkCatalog = {
  document: (id) => documents[id],
  settlement: (id) => settlements[id],
  documentAt: (uri) => (uri in addresses ? addresses[uri] : null),
};
const holder: LinkHolder = {
  uri: "manuscript://book/ch1",
  projectId: "p1",
  view: { kind: "live" },
};

it("resolves and spells stored links by rule", () => {
  const rows: {
    name: string;
    ref: string | null;
    href: string;
    grammar?: "holder" | "manuscript-root";
    holderUri?: string | null;
    kind: string;
    inBranch?: boolean;
    /** Rule 3: answered through the ahead ref's settlement. */
    settled?: true;
    spelled: string;
    address: string | null;
  }[] = [
    {
      name: "live document spells relative with the stored suffix",
      ref: `doc:${U.sibling}`,
      href: "manuscript://book/before-move#scene-2",
      kind: "document",
      inBranch: false,
      spelled: "ch2#scene-2",
      address: "manuscript://book/ch2",
    },
    {
      name: "cross-area target spells the full URI",
      ref: `doc:${U.cast}`,
      href: "kb://cast/Lin Feng",
      kind: "document",
      spelled: "kb://cast/Lin Feng",
      address: "kb://cast/Lin Feng",
    },
    {
      name: "chat (no holder) spells full URIs",
      ref: `doc:${U.sibling}`,
      href: "manuscript://book/ch2",
      holderUri: null,
      kind: "document",
      spelled: "manuscript://book/ch2",
      address: "manuscript://book/ch2",
    },
    {
      name: "a document only in a branch resolves in the branch",
      ref: `doc:${U.drafted}`,
      href: "manuscript://book/new",
      kind: "document",
      inBranch: true,
      spelled: "new",
      address: "manuscript://book/new",
    },
    {
      name: "deleted target is gone and spells the stored href",
      ref: `doc:${U.deleted}`,
      href: "manuscript://book/old?v=1",
      kind: "gone",
      spelled: "manuscript://book/old?v=1",
      address: "manuscript://book/old",
    },
    {
      name: "unreadable target is gone without leaking its path",
      ref: `doc:${U.secret}`,
      href: "manuscript://book/where-it-was",
      kind: "gone",
      spelled: "manuscript://book/where-it-was",
      address: "manuscript://book/where-it-was",
    },
    {
      name: "other-project target is gone",
      ref: `doc:${U.foreign}`,
      href: "manuscript://theirs",
      kind: "gone",
      spelled: "manuscript://theirs",
      address: "manuscript://theirs",
    },
    {
      name: "unknown document is gone, never the document at its address",
      ref: `doc:${U.unknown}`,
      href: "manuscript://book/arrived",
      kind: "gone",
      spelled: "manuscript://book/arrived",
      address: "manuscript://book/arrived",
    },
    {
      name: "snapshot miss is unknown and spells stored",
      ref: `doc:${U.neverLoaded}`,
      href: "manuscript://book/ch2",
      kind: "unknown",
      spelled: "manuscript://book/ch2",
      address: "manuscript://book/ch2",
    },
    {
      name: "settled ahead ref follows its document",
      ref: `ahead:${U.settled}`,
      href: "manuscript://book/lin",
      kind: "document",
      settled: true,
      spelled: "kb://cast/Lin Feng",
      address: "kb://cast/Lin Feng",
    },
    {
      name: "ahead ref settled on a deleted document is gone",
      ref: `ahead:${U.settledGone}`,
      href: "manuscript://book/old",
      kind: "gone",
      settled: true,
      spelled: "manuscript://book/old",
      address: "manuscript://book/old",
    },
    {
      name: "unsettled ahead ref resolves the document at its exact address",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/arrived",
      kind: "document",
      spelled: "arrived",
      address: "manuscript://book/arrived",
    },
    {
      name: "unsettled ahead ref with nothing there spells its canonical address",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/ch12#top",
      kind: "ahead",
      spelled: "ch12#top",
      address: "manuscript://book/ch12",
    },
    {
      name: "unsettled ahead ref does not reveal an unreadable occupant",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/secret",
      kind: "ahead",
      spelled: "secret",
      address: "manuscript://book/secret",
    },
    {
      name: "unsettled ahead ref at an unloaded address is unknown",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/unloaded",
      kind: "unknown",
      spelled: "manuscript://book/unloaded",
      address: "manuscript://book/unloaded",
    },
    {
      name: "unregistered ahead ref is unknown",
      ref: `ahead:${U.unregistered}`,
      href: "manuscript://book/ch13",
      kind: "unknown",
      spelled: "manuscript://book/ch13",
      address: "manuscript://book/ch13",
    },
    {
      name: "no ref keeps today's address rules and spells as written",
      ref: null,
      href: "../notes/kael",
      kind: "address",
      spelled: "../notes/kael",
      address: null,
    },
    {
      name: "malformed ref is gone",
      ref: "doc:",
      href: "manuscript://book/ch2",
      kind: "gone",
      spelled: "manuscript://book/ch2",
      address: "manuscript://book/ch2",
    },
    {
      name: "short non-UUID ref is malformed, so gone",
      ref: "doc:sibling",
      href: "manuscript://book/ch2",
      kind: "gone",
      spelled: "manuscript://book/ch2",
      address: "manuscript://book/ch2",
    },
    {
      name: "image source spells manuscript-root-relative",
      ref: `doc:${U.picture}`,
      href: "manuscript://assets/old-name.png",
      grammar: "manuscript-root",
      kind: "document",
      spelled: "assets/gate.png",
      address: "manuscript://assets/gate.png",
    },
    {
      name: "image source outside the manuscript spells the full URI",
      ref: `doc:${U.cast}`,
      href: "kb://cast/Lin Feng",
      grammar: "manuscript-root",
      kind: "document",
      spelled: "kb://cast/Lin Feng",
      address: "kb://cast/Lin Feng",
    },
  ];
  for (const row of rows) {
    const link = { ref: row.ref, href: row.href };
    const at = row.holderUri === undefined ? holder : { ...holder, uri: row.holderUri };
    const resolution = resolveStoredLink(link, catalog);
    expect.soft(resolution.kind, row.name).toBe(row.kind);
    if (row.inBranch !== undefined && resolution.kind === "document")
      expect.soft(resolution.inBranch, row.name).toBe(row.inBranch);
    expect.soft("settled" in resolution && resolution.settled, row.name).toBe(row.settled ?? false);
    expect
      .soft(spellStoredLink(link, at, resolution, row.grammar ?? "holder"), row.name)
      .toEqual({ href: row.spelled, address: row.address });
  }
});

it("classifies written links and mints ahead addresses by grammar", () => {
  const classified: [string, string | null, ReturnType<typeof classifyWrittenLink>][] = [
    ["ch2.md#a", "manuscript://book/ch1.md", internal("manuscript://book/ch2.md", "#a")],
    ["../kb.md", "manuscript://book/ch1.md", internal("manuscript://kb.md", "")],
    ["Kb://cast/Lin%20Feng.md", null, internal("kb://cast/Lin Feng.md", "")],
    ["scratch://notes.md", "manuscript://book/ch1.md", { kind: "contextual" }],
    ["scratch://@/notes.md", "manuscript://book/ch1.md", { kind: "external" }],
    ["manuscript://ch1.md", "user://journal/today.md", { kind: "contextual" }],
    ["user://journal/old.md", "user://journal/today.md", internal("user://journal/old.md", "")],
    ["ch2.md", null, { kind: "external" }],
    ["https://example.com/a.md", "manuscript://book/ch1.md", { kind: "external" }],
    ["javascript:alert(1)", "manuscript://book/ch1.md", { kind: "external" }],
  ];
  for (const [href, holderUri, expected] of classified)
    expect
      .soft(classifyWrittenLink(href, holderUri), `link ${href} in ${holderUri}`)
      .toEqual(expected);

  const sources: [string, ReturnType<typeof classifyWrittenSource>][] = [
    ["assets/gate.png", internal("manuscript://assets/gate.png", "")],
    ["kb://maps/realm.png", internal("kb://maps/realm.png", "")],
    ["../escape.png", { kind: "external" }],
    ["https://example.com/a.png", { kind: "external" }],
    ["//cdn.example.com/map.png", { kind: "external" }],
    ["assets/50%.png?v=50%", internal("manuscript://assets/50%.png", "?v=50%")],
  ];
  for (const [src, expected] of sources)
    expect.soft(classifyWrittenSource(src), `source ${src}`).toEqual(expected);

  const minted: [string, "link" | "source", string | null][] = [
    ["manuscript://book/ch12", "link", "manuscript://book/ch12"],
    ["manuscript://book/ch12.mdx", "link", "manuscript://book/ch12"],
    ["manuscript://book/.hidden", "link", "manuscript://book/.hidden"],
    ["manuscript://book/chapter.", "link", "manuscript://book/chapter."],
    ["manuscript://book/....", "link", null],
    ["manuscript://assets/gate.", "source", null],
    ["manuscript://assets/.png", "source", null],
    ["manuscript://assets/gate", "source", null],
    ["manuscript://assets/gate.png", "source", "manuscript://assets/gate.png"],
    ["manuscript://book/ch12.md", "link", "manuscript://book/ch12"],
    ["manuscript://book/notes.txt", "link", "manuscript://book/notes"],
    ["manuscript://book/outline.json", "link", "manuscript://book/outline.json"],
    ["ch12", "link", null],
  ];
  for (const [uri, kind, expected] of minted) {
    const address = aheadAddress(uri, kind);
    expect.soft(address, `ahead ${kind} ${uri}`).toBe(expected);
    // Every minted address is one the registry accepts.
    if (address)
      expect.soft(isAheadFilename(address.slice(address.lastIndexOf("/") + 1)), address).toBe(true);
  }

  const uuid = "550E8400-E29B-41D4-A716-446655440000";
  const refs: [unknown, ReturnType<typeof parseLinkRef>][] = [
    [`doc:${uuid}`, { kind: "doc", documentId: uuid.toLowerCase() }],
    [`ahead:${uuid}`, { kind: "ahead", aheadId: uuid.toLowerCase() }],
    [null, null],
    ["", null],
    ["doc:", null],
    ["doc:A", null],
    ["ahead:opaque", null],
    ["doc:a_b", null],
    [`doc:{${uuid}}`, null],
    [`doc:${uuid.replaceAll("-", "")}`, null],
    [`doc:${uuid} `, null],
    [`asset:${uuid}`, null],
    ["doc:a' OR 1=1", null],
  ];
  for (const [value, expected] of refs)
    expect.soft(parseLinkRef(value), `ref ${String(value)}`).toEqual(expected);

  // Classify -> mint and store -> resolve -> spell: an address is decoded, a
  // stored href is escaped, and filename characters never become href syntax.
  const roundTrips: {
    written: string;
    kind: "link" | "source";
    address: string;
    stored: string;
    spelled: string;
  }[] = [
    {
      written: "next%23part.md",
      kind: "link",
      address: "manuscript://book/next#part",
      stored: "manuscript://book/next%23part",
      spelled: "next%23part",
    },
    {
      written: "100%25.md",
      kind: "link",
      address: "manuscript://book/100%",
      stored: "manuscript://book/100%25",
      spelled: "100%25",
    },
    {
      written: "literal%2520.md",
      kind: "link",
      address: "manuscript://book/literal%20",
      stored: "manuscript://book/literal%2520",
      spelled: "literal%2520",
    },
    {
      written: "next%3Fpart.md",
      kind: "link",
      address: "manuscript://book/next?part",
      stored: "manuscript://book/next%3Fpart",
      spelled: "next%3Fpart",
    },
    {
      written: "next.md?q=a#part",
      kind: "link",
      address: "manuscript://book/next",
      stored: "manuscript://book/next?q=a#part",
      spelled: "next?q=a#part",
    },
    {
      written: "100%25%23two?v=1#top",
      kind: "link",
      address: "manuscript://book/100%#two",
      stored: "manuscript://book/100%25%23two?v=1#top",
      spelled: "100%25%23two?v=1#top",
    },
    {
      written: "assets/map%23one.png",
      kind: "source",
      address: "manuscript://assets/map#one.png",
      stored: "manuscript://assets/map%23one.png",
      spelled: "assets/map%23one.png",
    },
    {
      written: "assets/100%25%2520.png?v=2#crop",
      kind: "source",
      address: "manuscript://assets/100%%20.png",
      stored: "manuscript://assets/100%25%2520.png?v=2#crop",
      spelled: "assets/100%25%2520.png?v=2#crop",
    },
  ];
  for (const row of roundTrips) {
    const grammar = row.kind === "link" ? "holder" : "manuscript-root";
    const classified =
      row.kind === "link"
        ? classifyWrittenLink(row.written, holder.uri)
        : classifyWrittenSource(row.written);
    if (classified.kind !== "internal") {
      expect.soft(classified.kind, row.written).toBe("internal");
      continue;
    }
    const address = aheadAddress(classified.uri, row.kind);
    expect.soft(address, `${row.written} address`).toBe(row.address);
    const stored = storedHref(address ?? "", classified.suffix);
    expect.soft(stored, `${row.written} stored`).toBe(row.stored);

    const asked: string[] = [];
    const empty: LinkCatalog = {
      document: () => null,
      settlement: () => null,
      documentAt: (uri) => {
        asked.push(uri);
        return null;
      },
    };
    const ahead = { ref: `ahead:${U.open}`, href: stored };
    const unsettled = resolveStoredLink(ahead, empty);
    expect.soft(asked, `${row.written} looks up the exact address`).toEqual([row.address]);
    expect
      .soft(spellStoredLink(ahead, holder, unsettled, grammar), `${row.written} ahead spelling`)
      .toEqual({ href: row.spelled, address: row.address });

    const arrived = doc(U.sibling, row.address);
    const atAddress: LinkCatalog = { ...empty, documentAt: () => arrived };
    const resolved = resolveStoredLink(ahead, atAddress);
    expect
      .soft(spellStoredLink(ahead, holder, resolved, grammar), `${row.written} arrived spelling`)
      .toEqual({ href: row.spelled, address: row.address });
  }
});

function internal(uri: string, suffix: string) {
  return { kind: "internal" as const, uri, suffix };
}

it("spells lineage links through their holder, without a chat-only spelling channel", () => {
  const target = doc(U.cast, "scratch://@c12/x");
  const resolution = { kind: "document", document: target, inBranch: false } as const;
  const link = { ref: `doc:${U.cast}`, href: "scratch://@c12/old#gate" };
  const ownScratch = { ...holder, uri: "scratch://@c12/holder" };
  expect(spellStoredLink(link, ownScratch, resolution, "holder").href).toBe("x#gate");
  // Contextual spelling already in the chat's own Scratch stays contextual.
  expect(
    spellStoredLink({ ref: null, href: "scratch://x" }, ownScratch, { kind: "address" }, "holder")
      .href,
  ).toBe("scratch://x");
  for (const uri of [null, "scratch://@c13/holder", "scratch://@w1/holder", "manuscript://holder"])
    expect(spellStoredLink(link, { ...holder, uri }, resolution, "holder").href).toBe(
      "scratch://@c12/x#gate",
    );
});

it("canonicalizes historical ahead basenames without changing folders, suffixes or identity", () => {
  const link = { ref: `ahead:${U.open}`, href: "manuscript://book.md/Chapter 15.md?view=1#scene" };
  const resolution = resolveStoredLink(link, catalog);
  expect(resolution).toEqual({
    kind: "ahead",
    uri: "manuscript://book.md/Chapter 15",
    suffix: "?view=1#scene",
  });
  expect(spellStoredLink(link, holder, resolution, "holder")).toEqual({
    href: "../book.md/Chapter 15?view=1#scene",
    address: "manuscript://book.md/Chapter 15",
  });
  expect(link).toEqual({
    ref: `ahead:${U.open}`,
    href: "manuscript://book.md/Chapter 15.md?view=1#scene",
  });
});
