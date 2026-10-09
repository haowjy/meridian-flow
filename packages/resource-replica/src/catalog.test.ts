import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { applyCatalogChanges, catalogFiles, catalogViewFromSnapshot } from "./catalog";

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
  it("replaces a subtree atomically after a separately published upsert without retaining stale entries", () => {
    const stale = { ...file, entryId: "removed-document" };
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source, folder, file, stale],
    });
    const renamed = {
      ...file,
      name: "Renamed.md",
      path: ["Arc", "Renamed.md"],
      uri: "manuscript://Arc/Renamed.md" as never,
    };
    const published = applyCatalogChanges(initial, {
      kind: "delta",
      scope,
      commits: [
        {
          eventId: "event-2",
          commitId: "commit-2",
          firstRevision: "2",
          lastRevision: "2",
          changes: [{ operation: "upsert", ordinal: 0, entry: renamed }],
        },
      ],
      nextCursor: "cursor-2",
      headRevision: "2",
      hasMore: false,
    });
    expect(published && catalogFiles(published)).toContainEqual(renamed);
    const delta = {
      kind: "delta" as const,
      scope,
      commits: [
        {
          eventId: "event-3",
          commitId: "commit-3",
          firstRevision: "3",
          lastRevision: "3",
          changes: [
            { operation: "invalidate-subtree" as const, ordinal: 0, rootEntryId: folder.entryId },
            { operation: "upsert" as const, ordinal: 1, entry: folder },
            { operation: "upsert" as const, ordinal: 2, entry: renamed },
          ],
        },
      ],
      nextCursor: "cursor-3",
      headRevision: "3",
      hasMore: false,
    };
    const replaced = published && applyCatalogChanges(published, delta);
    const fresh = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "3",
      cursor: "cursor-3",
      entries: [source, folder, renamed],
    });
    expect(replaced).toEqual(fresh);
    expect(replaced && applyCatalogChanges(replaced, delta)).toEqual(fresh);
    const deleted =
      replaced &&
      applyCatalogChanges(replaced, {
        kind: "delta",
        scope,
        commits: [
          {
            eventId: "event-4",
            commitId: "commit-4",
            firstRevision: "4",
            lastRevision: "4",
            changes: [
              { operation: "invalidate-subtree", ordinal: 0, rootEntryId: renamed.entryId },
            ],
          },
        ],
        nextCursor: "cursor-4",
        headRevision: "4",
        hasMore: false,
      });
    expect(deleted?.entries.has(renamed.entryId)).toBe(false);
    expect(deleted && catalogFiles(deleted)).toEqual([]);
    expect(initial.entries.has(stale.entryId)).toBe(true);
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
