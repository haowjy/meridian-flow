import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  applyCatalogChanges,
  catalogChildren,
  catalogFiles,
  catalogViewFromSnapshot,
} from "./context-catalog-cache";

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const source: CatalogEntry = {
  kind: "source",
  entryId: "source-1",
  scope,
  scheme: "manuscript",
  name: "Manuscript",
  uri: "manuscript://" as never,
};
const folder: CatalogEntry = {
  kind: "folder",
  entryId: "folder-1",
  scope,
  sourceId: "source-1",
  parentId: "source-1",
  name: "Arc",
  path: ["Arc"],
  uri: "manuscript://Arc" as never,
  hasChildren: true,
};
const file: CatalogEntry = {
  kind: "file",
  entryId: "document-1",
  scope,
  sourceId: "source-1",
  parentId: "folder-1",
  name: "Chapter.md",
  aliases: [],
  path: ["Arc", "Chapter.md"],
  uri: "manuscript://Arc/Chapter.md" as never,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: false,
};

describe("catalog cache reducer", () => {
  it("normalizes one identity for tree and picker projections", () => {
    const view = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source, folder, file],
    });
    expect(catalogChildren(view, "folder-1")[0]).toBe(catalogFiles(view)[0]);
  });

  it("applies whole commits idempotently and invalidates a subtree immediately", () => {
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source, folder, file],
    });
    const delta = {
      kind: "delta" as const,
      scope,
      commits: [
        {
          eventId: "event-2",
          commitId: "commit-2",
          firstRevision: "2",
          lastRevision: "2",
          changes: [
            { operation: "invalidate-subtree" as const, ordinal: 0, rootEntryId: "folder-1" },
          ],
        },
      ],
      nextCursor: "cursor-2",
      headRevision: "2",
      hasMore: false,
    };
    const first = applyCatalogChanges(initial, delta);
    const duplicate = first && applyCatalogChanges(first, delta);
    expect(first && catalogFiles(first)).toEqual([]);
    expect(duplicate?.entries.size).toBe(3);
    expect(duplicate?.cursor).toBe("cursor-2");
  });

  it("applies bounded pages without advancing applied revision to the observed head", () => {
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "0",
      cursor: "cursor-0",
      entries: [source],
    });
    const page1 = applyCatalogChanges(initial, {
      kind: "delta",
      scope,
      commits: [
        { eventId: "e1", commitId: "c1", firstRevision: "1", lastRevision: "1", changes: [] },
      ],
      nextCursor: "cursor-1",
      headRevision: "2",
      hasMore: true,
    });
    expect(page1?.appliedRevision).toBe("1");
    expect(page1?.observedHeadRevision).toBe("2");
    const page2 =
      page1 &&
      applyCatalogChanges(page1, {
        kind: "delta",
        scope,
        commits: [
          { eventId: "e2", commitId: "c2", firstRevision: "2", lastRevision: "2", changes: [] },
        ],
        nextCursor: "cursor-2",
        headRevision: "2",
        hasMore: false,
      });
    expect(page2?.appliedRevision).toBe("2");
  });

  it("rejects a commit newer than the reported head without mutating the live view", () => {
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source],
    });
    const result = applyCatalogChanges(initial, {
      kind: "delta",
      scope,
      commits: [
        { eventId: "e2", commitId: "c2", firstRevision: "2", lastRevision: "2", changes: [] },
      ],
      nextCursor: "cursor-2",
      headRevision: "1",
      hasMore: false,
    });
    expect(result).toBeNull();
    expect(initial.appliedRevision).toBe("1");
  });

  it("requests snapshot replacement on reset without mutating live state", () => {
    const before = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source],
    });
    expect(
      applyCatalogChanges(before, { kind: "reset-required", scope, reason: "expired" }),
    ).toBeNull();
    expect(before.entries.size).toBe(1);
  });
});
