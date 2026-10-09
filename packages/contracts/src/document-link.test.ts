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
} from "./document-link.js";
import { aheadAddress, parseLinkRef } from "./document-ref.js";

const doc = (documentId: string, uri: string, extra: Partial<CatalogDocument> = {}) => ({
  documentId,
  projectId: "p1",
  uri,
  presence: "live" as const,
  readable: true,
  nameable: true,
  ...extra,
});
const documents: Record<string, CatalogDocument | null> = {
  sibling: doc("sibling", "manuscript://book/ch2.md"),
  cast: doc("cast", "kb://cast/Lin Feng.md"),
  drafted: doc("drafted", "manuscript://book/new.md", { presence: "draft" }),
  deleted: doc("deleted", "manuscript://book/old.md", { presence: "deleted" }),
  secret: doc("secret", "manuscript://book/secret.md", { readable: false }),
  foreign: doc("foreign", "manuscript://theirs.md", { projectId: "p2", nameable: false }),
  picture: doc("picture", "manuscript://assets/gate.png"),
  occupant: doc("occupant", "manuscript://book/arrived.md"),
  unknown: null,
};
const settlements: Record<string, string | null> = {
  settled: "cast",
  settledGone: "deleted",
  open: null,
};
const addresses: Record<string, CatalogDocument | null | undefined> = {
  "manuscript://book/arrived.md": documents.occupant,
  "manuscript://book/secret.md": documents.secret,
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
    spelled: string;
    address: string | null;
  }[] = [
    {
      name: "live document spells relative with the stored suffix",
      ref: "doc:sibling",
      href: "manuscript://book/before-move.md#scene-2",
      kind: "document",
      inDraft: false,
      spelled: "ch2.md#scene-2",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "cross-area target spells the full URI",
      ref: "doc:cast",
      href: "kb://cast/Lin Feng.md",
      kind: "document",
      spelled: "kb://cast/Lin Feng.md",
      address: "kb://cast/Lin Feng.md",
    },
    {
      name: "chat (no holder) spells full URIs",
      ref: "doc:sibling",
      href: "manuscript://book/ch2.md",
      holderUri: null,
      kind: "document",
      spelled: "manuscript://book/ch2.md",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "a document only in a draft resolves in the draft",
      ref: "doc:drafted",
      href: "manuscript://book/new.md",
      kind: "document",
      inDraft: true,
      spelled: "new.md",
      address: "manuscript://book/new.md",
    },
    {
      name: "deleted target is gone and spells the stored href",
      ref: "doc:deleted",
      href: "manuscript://book/old.md?v=1",
      kind: "gone",
      spelled: "manuscript://book/old.md?v=1",
      address: "manuscript://book/old.md",
    },
    {
      name: "unreadable target is gone without leaking its path",
      ref: "doc:secret",
      href: "manuscript://book/where-it-was.md",
      kind: "gone",
      spelled: "manuscript://book/where-it-was.md",
      address: "manuscript://book/where-it-was.md",
    },
    {
      name: "other-project target is gone",
      ref: "doc:foreign",
      href: "manuscript://theirs.md",
      kind: "gone",
      spelled: "manuscript://theirs.md",
      address: "manuscript://theirs.md",
    },
    {
      name: "unknown document is gone, never the document at its address",
      ref: "doc:unknown",
      href: "manuscript://book/arrived.md",
      kind: "gone",
      spelled: "manuscript://book/arrived.md",
      address: "manuscript://book/arrived.md",
    },
    {
      name: "snapshot miss is unknown and spells stored",
      ref: "doc:never-loaded",
      href: "manuscript://book/ch2.md",
      kind: "unknown",
      spelled: "manuscript://book/ch2.md",
      address: "manuscript://book/ch2.md",
    },
    {
      name: "settled ahead ref follows its document",
      ref: "ahead:settled",
      href: "manuscript://book/lin.md",
      kind: "document",
      spelled: "kb://cast/Lin Feng.md",
      address: "kb://cast/Lin Feng.md",
    },
    {
      name: "ahead ref settled on a deleted document is gone",
      ref: "ahead:settledGone",
      href: "manuscript://book/old.md",
      kind: "gone",
      spelled: "manuscript://book/old.md",
      address: "manuscript://book/old.md",
    },
    {
      name: "unsettled ahead ref resolves the document at its exact address",
      ref: "ahead:open",
      href: "manuscript://book/arrived.md",
      kind: "document",
      spelled: "arrived.md",
      address: "manuscript://book/arrived.md",
    },
    {
      name: "unsettled ahead ref with nothing there spells its canonical address",
      ref: "ahead:open",
      href: "manuscript://book/ch12.md#top",
      kind: "ahead",
      spelled: "ch12.md#top",
      address: "manuscript://book/ch12.md",
    },
    {
      name: "unsettled ahead ref does not reveal an unreadable occupant",
      ref: "ahead:open",
      href: "manuscript://book/secret.md",
      kind: "ahead",
      spelled: "secret.md",
      address: "manuscript://book/secret.md",
    },
    {
      name: "unsettled ahead ref at an unloaded address is unknown",
      ref: "ahead:open",
      href: "manuscript://book/unloaded.md",
      kind: "unknown",
      spelled: "manuscript://book/unloaded.md",
      address: "manuscript://book/unloaded.md",
    },
    {
      name: "unregistered ahead ref is unknown",
      ref: "ahead:unregistered",
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
      name: "image source spells manuscript-root-relative",
      ref: "doc:picture",
      href: "manuscript://assets/old-name.png",
      grammar: "manuscript-root",
      kind: "document",
      spelled: "assets/gate.png",
      address: "manuscript://assets/gate.png",
    },
    {
      name: "image source outside the manuscript spells the full URI",
      ref: "doc:cast",
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
    const resolution = resolveStoredLink(link, at, catalog);
    expect.soft(resolution.kind, row.name).toBe(row.kind);
    if (row.inDraft !== undefined && resolution.kind === "document")
      expect.soft(resolution.inDraft, row.name).toBe(row.inDraft);
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
    ["scratch://@/notes.md", "manuscript://book/ch1.md", internal("scratch://@/notes.md", "")],
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
  ];
  for (const [src, expected] of sources)
    expect.soft(classifyWrittenSource(src), `source ${src}`).toEqual(expected);

  const minted: [string, "link" | "source", string | null][] = [
    ["manuscript://book/ch12", "link", "manuscript://book/ch12.md"],
    ["manuscript://book/ch12.mdx", "link", "manuscript://book/ch12.mdx"],
    ["manuscript://book/.hidden", "link", "manuscript://book/.hidden.md"],
    ["manuscript://assets/gate", "source", null],
    ["manuscript://assets/gate.png", "source", "manuscript://assets/gate.png"],
    ["ch12", "link", null],
  ];
  for (const [uri, kind, expected] of minted)
    expect.soft(aheadAddress(uri, kind), `ahead ${kind} ${uri}`).toBe(expected);

  const refs: [unknown, ReturnType<typeof parseLinkRef>][] = [
    ["doc:6f1c-9", { kind: "doc", documentId: "6f1c-9" }],
    ["ahead:opaque", { kind: "ahead", aheadId: "opaque" }],
    [null, null],
    ["", null],
    ["doc:", null],
    ["asset:abc", null],
    ["doc:a b", null],
    ["ahead:a:b", null],
  ];
  for (const [value, expected] of refs)
    expect.soft(parseLinkRef(value), `ref ${String(value)}`).toEqual(expected);
});

function internal(uri: string, suffix: string) {
  return { kind: "internal" as const, uri, suffix };
}
