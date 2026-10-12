/** Where status rows sit: under the destination folder by its id, wherever it has moved. */
import type { ImportSummary } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import type {
  CatalogContextView,
  CatalogDirectory,
} from "@/client/query/context-catalog-projection";
import type { ImportState } from "./import-state";
import { statusParents } from "./placements";

const root: CatalogDirectory = {
  kind: "dir",
  entryId: "root",
  parentId: null,
  name: "Knowledge Base",
  path: "/",
  uri: "kb://",
};

/** A catalog holding folders by id at their current paths. */
function catalogWith(folders: Record<string, string[]>): CatalogContextView {
  const entries = new Map(
    Object.entries(folders).map(([id, path]) => [id, { kind: "folder", path }]),
  );
  return {
    normalized: { entries } as never,
    root,
    children: () => [],
    files: () => [],
    findPath: (path) => {
      for (const [id, segments] of Object.entries(folders))
        if (`/${segments.join("/")}` === path)
          return { ...root, entryId: id, path, name: segments.at(-1) ?? "" };
      return null;
    },
    findDocument: () => null,
  };
}

/** An import another tab started: only the server's summary is known here. */
function elsewhere(destination: ImportSummary["destination"]): ImportState {
  return {
    importId: "import-1",
    local: null,
    load: "idle",
    refreshFailed: false,
    dismissing: false,
    dismissFailed: false,
    activitySeenAt: null,
    stop: "none",
    report: {
      summary: {
        importId: "import-1",
        state: "ready",
        destination,
        sort: false,
        counts: {
          total: 1,
          landed: 0,
          failed: 0,
          arriving: 1,
          deleted: 0,
          notImported: 0,
          skipped: 0,
          findings: 0,
        },
        lastActivityAt: new Date().toISOString(),
        version: "1",
        dismissedAt: null,
      },
      roots: [],
      entries: new Map(),
      complete: false,
    },
  } as ImportState;
}

describe("statusParents", () => {
  it("follows another tab's destination folder by id after it is renamed", () => {
    const catalog = catalogWith({ "folder-book": ["Renamed"], "folder-other": ["Book"] });
    const state = elsewhere({ folderUri: "kb://Book/", folderId: "folder-book" });
    expect(statusParents(catalog, "kb", [state])).toEqual(new Map([["folder-book", ["import-1"]]]));
  });

  it("puts the row at the area root when the destination folder is gone", () => {
    const catalog = catalogWith({ "folder-other": ["Book"] });
    const state = elsewhere({ folderUri: "kb://Book/", folderId: "folder-book" });
    expect(statusParents(catalog, "kb", [state])).toEqual(new Map([["root", ["import-1"]]]));
  });
});
