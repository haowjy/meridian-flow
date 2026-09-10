import { parseContextUri } from "@meridian/contracts";
import type {
  CatalogAuthorityEntry,
  CatalogFileEntry,
  CatalogScope,
} from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";

import {
  authoritativeReferenceForFile,
  type ReferenceRow,
  rankReferenceRows,
  referenceAuthorityIndex,
} from "./reference-policy";

const projectScope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const workScope = {
  kind: "work",
  projectId: "project-1",
  workId: "work-1",
} as const satisfies CatalogScope;
const noneScope = { kind: "none", projectId: "project-1" } as const satisfies CatalogScope;

function workSlug(value: string) {
  const decoded = decodeWorkSlug(value);
  if (!decoded) throw new Error(`invalid fixture Work slug: ${value}`);
  return decoded;
}

const workAuthority: CatalogAuthorityEntry = {
  kind: "authority",
  entryId: "work-1",
  scope: projectScope,
  authority: { kind: "work", workId: "work-1", workSlug: workSlug("revision-pass") },
  name: "Revision pass",
  available: true,
  entityRevision: "1",
};

function file(
  documentId: string,
  name: string,
  scope: CatalogScope = projectScope,
  aliases: readonly string[] = [],
): CatalogFileEntry {
  const scheme = scope.kind === "project" ? "manuscript" : "scratch";
  const qualifier = scope.kind === "work" ? "@revision-pass/" : scope.kind === "none" ? "@/" : "";
  return {
    kind: "file",
    entryId: documentId,
    scope,
    sourceId: `source-${scope.kind}`,
    parentId: `source-${scope.kind}`,
    name,
    aliases,
    path: [name],
    uri: `${scheme}://${qualifier}${name}`,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

function row(
  documentId: string,
  name: string,
  aliases: readonly string[] = [],
  scope: CatalogScope = projectScope,
): Extract<ReferenceRow, { kind: "file" }> {
  const reference = authoritativeReferenceForFile(
    file(documentId, name, scope, aliases),
    referenceAuthorityIndex([workAuthority]),
  );
  if (!reference) throw new Error("fixture reference did not materialize");
  return {
    kind: "file",
    rowId: `file:${documentId}`,
    label: name,
    location: "",
    fileKind: "document",
    aliases,
    matchedAlias: null,
    ambiguous: false,
    action: { type: "select", reference },
  };
}

function documentIds(rows: readonly ReferenceRow[]): string[] {
  return rows.flatMap((item) => (item.kind === "file" ? [item.action.reference.documentId] : []));
}

describe("reference identity and URI policy", () => {
  it("materializes contextual Work and no-Work catalog URIs into stable authority", () => {
    expect(
      authoritativeReferenceForFile(
        file("work-doc", "notes.md", workScope),
        referenceAuthorityIndex([workAuthority]),
      ),
    ).toMatchObject({
      documentId: "work-doc",
      uri: "scratch://@revision-pass/notes.md",
      fileType: "markdown",
      authority: {
        kind: "work",
        projectId: "project-1",
        workId: "work-1",
        workSlug: "revision-pass",
      },
    });
    expect(
      authoritativeReferenceForFile(
        file("none-doc", "notes.md", noneScope),
        referenceAuthorityIndex([]),
      ),
    ).toMatchObject({
      uri: "scratch://@/notes.md",
      authority: { kind: "none", projectId: "project-1" },
    });
  });

  it("refuses a Work terminal when stable slug authority is unavailable", () => {
    expect(
      authoritativeReferenceForFile(file("work-doc", "notes.md", workScope), new Map()),
    ).toBeNull();
  });

  it("keeps omitted authority contextual until terminal resolution and rejects bare @ as a URI", () => {
    expect(parseContextUri("scratch://notes.md")).toMatchObject({
      ok: true,
      value: { authority: { kind: "contextual" } },
    });
    expect(
      authoritativeReferenceForFile(
        { ...file("work-doc", "notes.md", workScope), uri: "scratch://notes.md" },
        referenceAuthorityIndex([workAuthority]),
      ),
    ).toBeNull();
    expect(parseContextUri("@")).toMatchObject({ ok: false });
  });
});

describe("reference ranking policy", () => {
  it("keeps exact lexical matches above every weak tier despite open-document priors", () => {
    const rows = [
      row("contains", "Floodgate Records"),
      row("word", "The Gate Ledger"),
      row("prefix", "Gatehouse"),
      row("fuzzy", "Great Archive Treasury Entry"),
      row("exact", "Gate"),
    ];
    expect(
      documentIds(
        rankReferenceRows(rows, "gate", {
          openDocumentIds: new Set(["contains", "word", "prefix", "fuzzy"]),
        }),
      ),
    ).toEqual(["exact", "prefix", "word", "contains", "fuzzy"]);
    expect(
      documentIds(
        rankReferenceRows([row("first", "Gate One"), row("second", "Gate Two")], "gate", {
          contextualDocumentIds: new Set(["second"]),
        }),
      ),
    ).toEqual(["second", "first"]);
  });

  it("matches aliases, reports duplicate labels as ambiguous, and keeps stable ties", () => {
    const rows = [
      row("first", "Notes", ["Warden"]),
      row("second", "Notes"),
      row("third", "Warden's Ledger"),
      row("fourth", "Keeper", ["Warden"]),
    ];
    const aliasMatches = rankReferenceRows(rows, "warden");
    expect(documentIds(aliasMatches)).toEqual(["first", "fourth", "third"]);
    expect(aliasMatches[0]).toMatchObject({ matchedAlias: "Warden", ambiguous: true });
    expect(aliasMatches[1]).toMatchObject({ matchedAlias: "Warden", ambiguous: true });
    expect(rankReferenceRows(rows, "notes").map((item) => item.rowId)).toEqual([
      "file:first",
      "file:second",
    ]);
  });

  it("deduplicates stable identity and applies the cap after the merged order", () => {
    const rows = [
      row("same", "Gate"),
      row("same", "Gate"),
      ...Array.from({ length: 25 }, (_, index) => row(`doc-${index}`, `Gate ${index}`)),
    ];
    const ranked = rankReferenceRows(rows, "gate");
    expect(ranked).toHaveLength(20);
    expect(documentIds(ranked).filter((documentId) => documentId === "same")).toHaveLength(1);
    expect(documentIds(ranked)[0]).toBe("same");
    expect(ranked[0]).toMatchObject({ ambiguous: false });
  });

  it("filters terminal kinds without removing shared navigation rows", () => {
    const document = row("document", "Map");
    const asset = { ...row("asset", "Map.png"), fileKind: "asset" as const };
    const source: ReferenceRow = {
      kind: "source",
      rowId: "source:manuscript",
      label: "Manuscript",
      location: "manuscript://",
      matchAliases: ["manuscript"],
      action: {
        type: "navigate",
        prefix: "manuscript://",
        scope: projectScope,
        containerId: "source-project",
        acquire: false,
      },
    };
    expect(rankReferenceRows([source, document, asset], "", { kinds: ["asset"] })).toEqual([
      source,
      asset,
    ]);
  });

  it("rejects invalid envelopes and treats a bare trigger as an empty browse query", () => {
    expect(rankReferenceRows([row("doc", "Gate")], "bad|query")).toEqual([]);
    expect(rankReferenceRows([row("doc", "Gate")], "g".repeat(81))).toEqual([]);
    expect(rankReferenceRows([row("doc", "Gate")], "")).toHaveLength(1);
  });
});
