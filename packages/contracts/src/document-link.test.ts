/** Stored-link resolution and spelling rules, and written-link classification. */
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
import { aheadAddress, hasFileExtension, parseLinkRef } from "./document-ref.js";

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
  [U.sibling]: doc(U.sibling, "manuscript://book/ch2.md"),
  [U.cast]: doc(U.cast, "kb://cast/Lin Feng.md"),
  [U.drafted]: doc(U.drafted, "manuscript://book/new.md", { presence: "draft" }),
  [U.deleted]: doc(U.deleted, "manuscript://book/old.md", { presence: "deleted" }),
  [U.secret]: doc(U.secret, "manuscript://book/secret.md", { readable: false }),
  [U.foreign]: doc(U.foreign, "manuscript://theirs.md", { projectId: "p2", nameable: false }),
  [U.picture]: doc(U.picture, "manuscript://assets/gate.png"),
  [U.occupant]: doc(U.occupant, "manuscript://book/arrived.md"),
  [U.unknown]: null,
};
const settlements: Record<string, string | null> = {
  [U.settled]: U.cast,
  [U.settledGone]: U.deleted,
  [U.open]: null,
};
const addresses: Record<string, CatalogDocument | null | undefined> = {
  "manuscript://book/arrived.md": documents[U.occupant],
  "manuscript://book/secret.md": documents[U.secret],
  "manuscript://book/unloaded.md": undefined,
};
const catalog: LinkCatalog = {
  document: (id) => documents[id],
  settlement: (id) => settlements[id],
  documentAt: (uri) => (uri in addresses ? addresses[uri] : null),
};
const holder: LinkHolder = {
  uri: "manuscript://book/ch1.md",
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
    inDraft?: boolean;
    /** Rule 3: answered through the ahead ref's settlement. */
    settled?: true;
    spelled: string;
    address: string | null;
  }[] = [
    {
      name: "live document spells relative with the stored suffix",
      ref: `doc:${U.sibling}`,
      href: "manuscript://book/before-move.md#scene-2",
      kind: "document",
      inDraft: false,
      spelled: "ch2.md#scene-2",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "cross-area target spells the full URI",
      ref: `doc:${U.cast}`,
      href: "kb://cast/Lin Feng.md",
      kind: "document",
      spelled: "kb://cast/Lin Feng.md",
      address: "kb://cast/Lin Feng.md",
    },
    {
      name: "chat (no holder) spells full URIs",
      ref: `doc:${U.sibling}`,
      href: "manuscript://book/ch2.md",
      holderUri: null,
      kind: "document",
      spelled: "manuscript://book/ch2.md",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "a document only in a draft resolves in the draft",
      ref: `doc:${U.drafted}`,
      href: "manuscript://book/new.md",
      kind: "document",
      inDraft: true,
      spelled: "new.md",
      address: "manuscript://book/new.md",
    },
    {
      name: "deleted target is gone and spells the stored href",
      ref: `doc:${U.deleted}`,
      href: "manuscript://book/old.md?v=1",
      kind: "gone",
      spelled: "manuscript://book/old.md?v=1",
      address: "manuscript://book/old.md",
    },
    {
      name: "unreadable target is gone without leaking its path",
      ref: `doc:${U.secret}`,
      href: "manuscript://book/where-it-was.md",
      kind: "gone",
      spelled: "manuscript://book/where-it-was.md",
      address: "manuscript://book/where-it-was.md",
    },
    {
      name: "other-project target is gone",
      ref: `doc:${U.foreign}`,
      href: "manuscript://theirs.md",
      kind: "gone",
      spelled: "manuscript://theirs.md",
      address: "manuscript://theirs.md",
    },
    {
      name: "unknown document is gone, never the document at its address",
      ref: `doc:${U.unknown}`,
      href: "manuscript://book/arrived.md",
      kind: "gone",
      spelled: "manuscript://book/arrived.md",
      address: "manuscript://book/arrived.md",
    },
    {
      name: "snapshot miss is unknown and spells stored",
      ref: `doc:${U.neverLoaded}`,
      href: "manuscript://book/ch2.md",
      kind: "unknown",
      spelled: "manuscript://book/ch2.md",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "settled ahead ref follows its document",
      ref: `ahead:${U.settled}`,
      href: "manuscript://book/lin.md",
      kind: "document",
      settled: true,
      spelled: "kb://cast/Lin Feng.md",
      address: "kb://cast/Lin Feng.md",
    },
    {
      name: "ahead ref settled on a deleted document is gone",
      ref: `ahead:${U.settledGone}`,
      href: "manuscript://book/old.md",
      kind: "gone",
      settled: true,
      spelled: "manuscript://book/old.md",
      address: "manuscript://book/old.md",
    },
    {
      name: "unsettled ahead ref resolves the document at its exact address",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/arrived.md",
      kind: "document",
      spelled: "arrived.md",
      address: "manuscript://book/arrived.md",
    },
    {
      name: "unsettled ahead ref with nothing there spells its canonical address",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/ch12.md#top",
      kind: "ahead",
      spelled: "ch12.md#top",
      address: "manuscript://book/ch12.md",
    },
    {
      name: "unsettled ahead ref does not reveal an unreadable occupant",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/secret.md",
      kind: "ahead",
      spelled: "secret.md",
      address: "manuscript://book/secret.md",
    },
    {
      name: "unsettled ahead ref at an unloaded address is unknown",
      ref: `ahead:${U.open}`,
      href: "manuscript://book/unloaded.md",
      kind: "unknown",
      spelled: "manuscript://book/unloaded.md",
      address: "manuscript://book/unloaded.md",
    },
    {
      name: "unregistered ahead ref is unknown",
      ref: `ahead:${U.unregistered}`,
      href: "manuscript://book/ch13.md",
      kind: "unknown",
      spelled: "manuscript://book/ch13.md",
      address: "manuscript://book/ch13.md",
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
      href: "manuscript://book/ch2.md",
      kind: "gone",
      spelled: "manuscript://book/ch2.md",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "short non-UUID ref is malformed, so gone",
      ref: "doc:sibling",
      href: "manuscript://book/ch2.md",
      kind: "gone",
      spelled: "manuscript://book/ch2.md",
      address: "manuscript://book/ch2.md",
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
      href: "kb://cast/Lin Feng.md",
      grammar: "manuscript-root",
      kind: "document",
      spelled: "kb://cast/Lin Feng.md",
      address: "kb://cast/Lin Feng.md",
    },
  ];
  for (const row of rows) {
    const link = { ref: row.ref, href: row.href };
    const at = row.holderUri === undefined ? holder : { ...holder, uri: row.holderUri };
    const resolution = resolveStoredLink(link, catalog);
    expect.soft(resolution.kind, row.name).toBe(row.kind);
    if (row.inDraft !== undefined && resolution.kind === "document")
      expect.soft(resolution.inDraft, row.name).toBe(row.inDraft);
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
    ["manuscript://book/ch12", "link", "manuscript://book/ch12.md"],
    ["manuscript://book/ch12.mdx", "link", "manuscript://book/ch12.mdx"],
    ["manuscript://book/.hidden", "link", "manuscript://book/.hidden.md"],
    ["manuscript://book/chapter.", "link", "manuscript://book/chapter..md"],
    ["manuscript://book/....", "link", null],
    ["manuscript://assets/gate.", "source", null],
    ["manuscript://assets/.png", "source", null],
    ["manuscript://assets/gate", "source", null],
    ["manuscript://assets/gate.png", "source", "manuscript://assets/gate.png"],
    ["ch12", "link", null],
  ];
  for (const [uri, kind, expected] of minted) {
    const address = aheadAddress(uri, kind);
    expect.soft(address, `ahead ${kind} ${uri}`).toBe(expected);
    // Every minted address is one the registry accepts.
    if (address)
      expect
        .soft(hasFileExtension(address.slice(address.lastIndexOf("/") + 1)), address)
        .toBe(true);
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
      address: "manuscript://book/next#part.md",
      stored: "manuscript://book/next%23part.md",
      spelled: "next%23part.md",
    },
    {
      written: "100%25.md",
      kind: "link",
      address: "manuscript://book/100%.md",
      stored: "manuscript://book/100%25.md",
      spelled: "100%25.md",
    },
    {
      written: "literal%2520.md",
      kind: "link",
      address: "manuscript://book/literal%20.md",
      stored: "manuscript://book/literal%2520.md",
      spelled: "literal%2520.md",
    },
    {
      written: "next%3Fpart.md",
      kind: "link",
      address: "manuscript://book/next?part.md",
      stored: "manuscript://book/next%3Fpart.md",
      spelled: "next%3Fpart.md",
    },
    {
      written: "next.md?q=a#part",
      kind: "link",
      address: "manuscript://book/next.md",
      stored: "manuscript://book/next.md?q=a#part",
      spelled: "next.md?q=a#part",
    },
    {
      written: "100%25%23two?v=1#top",
      kind: "link",
      address: "manuscript://book/100%#two.md",
      stored: "manuscript://book/100%25%23two.md?v=1#top",
      spelled: "100%25%23two.md?v=1#top",
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
  const target = doc(U.cast, "scratch://@/c12/x.md");
  const resolution = { kind: "document", document: target, inDraft: false } as const;
  const link = { ref: `doc:${U.cast}`, href: "scratch://@/c12/old.md#gate" };
  const ownScratch = { ...holder, uri: "scratch://@/c12/holder.md" };
  expect(spellStoredLink(link, ownScratch, resolution, "holder").href).toBe("x.md#gate");
  // Contextual spelling already in the chat's own Scratch stays contextual.
  expect(
    spellStoredLink(
      { ref: null, href: "scratch://x.md" },
      ownScratch,
      { kind: "address" },
      "holder",
    ).href,
  ).toBe("scratch://x.md");
  for (const uri of [
    null,
    "scratch://@/c13/holder.md",
    "scratch://@arc/holder.md",
    "manuscript://holder.md",
  ])
    expect(spellStoredLink(link, { ...holder, uri }, resolution, "holder").href).toBe(
      "scratch://@/c12/x.md#gate",
    );
});
