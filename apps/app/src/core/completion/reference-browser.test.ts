/**
 * The `@` browser's link-ahead row: offered by a host that can hold a link to
 * a document nobody has written yet, only when the search names no document
 * exactly, and chosen through the host's own callback.
 */
import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "@meridian/resource-replica";
import { describe, expect, it, vi } from "vitest";

import {
  createReferenceBrowserController,
  type ReferenceBrowserOptions,
  type ReferenceMenuRow,
} from "./reference-browser";

const PROJECT = "01900000-0000-7000-8000-000000000002";
const scope = { kind: "project", projectId: PROJECT } as CatalogScope;

function view(files: string[]): CatalogCacheView {
  const source = {
    kind: "source",
    entryId: "source-manuscript",
    scope,
    scheme: "manuscript",
    name: "Manuscript",
    uri: "manuscript://",
  } as CatalogEntry;
  const entries: CatalogEntry[] = files.map(
    (name, index) =>
      ({
        kind: "file",
        entryId: `01900000-0000-7000-8000-00000000010${index}`,
        scope,
        sourceId: "source-manuscript",
        parentId: "source-manuscript",
        name,
        aliases: [],
        path: [name],
        uri: `manuscript://${name}`,
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      }) as CatalogEntry,
  );
  return {
    scope,
    generation: "1",
    appliedRevision: "1",
    observedHeadRevision: "1",
    cursor: "",
    entries: new Map([source, ...entries].map((entry) => [entry.entryId, entry])),
    invalidatedEntryIds: new Set(),
    childIdsByParentId: new Map([["source-manuscript", entries.map((entry) => entry.entryId)]]),
    sourceIdsByScheme: new Map([["manuscript", "source-manuscript"]]),
  };
}

function browse(
  query: string,
  options: Partial<ReferenceBrowserOptions> = {},
  files = ["chapter-1.md", "Lin Feng.md"],
) {
  const catalog = view(files);
  const controller = createReferenceBrowserController({
    catalog: {
      subscribe: () => () => {},
      status: () => "ready",
      read: () => catalog,
      acquire: async () => catalog,
    },
    openContext: () => ({ warmScopes: [scope] }),
    label: () => "Reference a file",
    onSelect: vi.fn(),
    onCompleteSegment: vi.fn(),
    ...options,
  });
  controller.start({
    query,
    text: `@${query}`,
    triggerRange: { from: 1, to: 2 + query.length },
    candidates: [],
    anchorRect: () => null,
    loading: false,
    requestExit: vi.fn(),
  });
  return controller;
}

const items = (controller: ReturnType<typeof browse>): readonly ReferenceMenuRow[] =>
  controller.menu.snapshot().items;

const linkAhead = (name: string) => ({ uri: `manuscript://volume-1/${name}.md` });

describe("the link-ahead row", () => {
  it("follows the catalog rows when the search names no document exactly", () => {
    const rows = items(browse("chapter", { linkAhead }));
    expect(rows.at(-1)).toEqual({
      kind: "link-ahead",
      rowId: "link-ahead",
      label: "chapter",
      uri: "manuscript://volume-1/chapter.md",
    });
    expect(rows.some((row) => row.kind === "file" && row.label === "chapter-1.md")).toBe(true);
  });

  it("steps aside for an exact name, with or without its extension", () => {
    for (const query of ["Lin Feng", "lin feng.md", "chapter-1"]) {
      expect(items(browse(query, { linkAhead })).some((row) => row.kind === "link-ahead")).toBe(
        false,
      );
    }
  });

  it("is absent when the host offers none for the name, or offers none at all", () => {
    expect(items(browse("Lin Mei", { linkAhead: () => null }))).toEqual([]);
    expect(items(browse("Lin Mei"))).toEqual([]);
    expect(items(browse("", { linkAhead })).some((row) => row.kind === "link-ahead")).toBe(false);
  });

  it("is chosen through the host's callback, with the trigger range", () => {
    const onLinkAhead = vi.fn();
    const onSelect = vi.fn();
    const controller = browse("Lin Mei", { linkAhead, onLinkAhead, onSelect });
    controller.menu.choose(0);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onLinkAhead).toHaveBeenCalledWith({
      row: expect.objectContaining({ kind: "link-ahead", label: "Lin Mei" }),
      triggerRange: { from: 1, to: 9 },
    });
  });
});
