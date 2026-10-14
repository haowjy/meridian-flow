/** One import's store: the entry cursor only moves past changes it has read. */
import type { ImportEntryReport, ImportReport, ImportSummary } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { fakeImportServer } from "./fake-import-server";
import type { ImportApi } from "./import-api-port";
import { ImportStore } from "./import-store";

const planned: ImportEntryReport = {
  entryId: 0,
  rootId: 0,
  path: "",
  filename: "Ch 1.md",
  size: 1,
  sha256: "a".repeat(64),
  documentId: "doc-0",
  kind: "note",
  state: "planned",
  uri: "kb://Ch 1",
  name: "Ch 1",
  reason: null,
  exists: true,
  wanted: false,
};
const landed: ImportEntryReport = { ...planned, state: "landed" };

function summary(version: string, state: ImportSummary["state"] = "ready"): ImportSummary {
  const done = state === "finished";
  return {
    importId: "import-1",
    state,
    destination: { folderUri: "kb://", folderId: null },
    counts: {
      total: 1,
      landed: done ? 1 : 0,
      failed: 0,
      arriving: done ? 0 : 1,
      deleted: 0,
      notImported: 0,
      skipped: 0,
    },
    lastActivityAt: "2026-10-12T00:00:00.000Z",
    version,
    dismissedAt: null,
  };
}

function report(version: string, entries: ImportEntryReport[]): ImportReport {
  return {
    ...summary(version),
    roots: [{ rootId: 0, kind: "file", name: "Ch 1.md", id: null, uri: null }],
    entries,
  };
}

/** A server whose `since` cut holds the landing at version 2. */
function server(): { api: ImportApi; since: string[] } {
  const since: string[] = [];
  const api: ImportApi = {
    ...fakeImportServer().api,
    changes: async (_projectId, _importId, version) => {
      since.push(version);
      return { ...summary("2", "finished"), roots: [], entries: version === "1" ? [landed] : [] };
    },
  };
  return { api, since };
}

describe("ImportStore", () => {
  it("reads the changes behind a newer open-list summary instead of skipping them", async () => {
    const { api, since } = server();
    const store = new ImportStore("p", "import-1", api);
    store.installReport(report("1", [planned]));
    store.seedSummary(summary("2", "finished"));

    await store.refresh();

    expect(since).toEqual(["1"]);
    expect(store.getSnapshot().report?.entries.get(0)?.state).toBe("landed");
  });

  it("a forced refresh reads the whole report even after a full read", async () => {
    const reads: string[] = [];
    const api: ImportApi = {
      ...fakeImportServer().api,
      report: async () => {
        reads.push("full");
        // Neither a moved root nor a lapsed claim moves the import's version.
        const now = report("1", [{ ...planned, state: "landing", wanted: true }]);
        return { ...now, roots: [{ ...now.roots[0], id: "doc-0", uri: "kb://Moved/Ch 1" }] };
      },
      changes: async () => {
        reads.push("changes");
        return { ...summary("1"), roots: [], entries: [] };
      },
    };
    const store = new ImportStore("p", "import-1", api);
    store.installReport(report("1", [{ ...planned, state: "landing", wanted: false }]));

    await store.refresh(true);

    expect(reads).toEqual(["full"]);
    expect(store.getSnapshot().report?.entries.get(0)?.wanted).toBe(true);
    expect(store.getSnapshot().report?.roots[0]?.uri).toBe("kb://Moved/Ch 1");
  });

  it("follows a moved root from what changed, so the report's Open goes to it", async () => {
    const api: ImportApi = {
      ...fakeImportServer().api,
      changes: async () => ({
        ...summary("2"),
        roots: [{ rootId: 0, kind: "file", name: "Ch 1.md", id: "doc-0", uri: "kb://Moved/Ch 1" }],
        entries: [],
      }),
    };
    const store = new ImportStore("p", "import-1", api);
    store.installReport(report("1", [planned]));

    await store.refresh();

    expect(store.getSnapshot().report?.roots).toEqual([
      { rootId: 0, kind: "file", name: "Ch 1.md", id: "doc-0", uri: "kb://Moved/Ch 1" },
    ]);
  });

  it("keeps polling until it has read up to a finished summary", async () => {
    const { api, since } = server();
    const store = new ImportStore("p", "import-1", api);
    store.installReport(report("1", [planned]));
    store.seedSummary(summary("2", "finished"));

    const stop = store.watch("notice");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(since).toEqual(["1"]);
    expect(store.getSnapshot().report?.entries.get(0)?.state).toBe("landed");
  });

  it("never lets an older answer replace a newer one", async () => {
    const { api } = server();
    const store = new ImportStore("p", "import-1", api);
    store.installReport({ ...report("3", [landed]), state: "finished" });
    store.installReport(report("1", [planned]));

    expect(store.getSnapshot().report?.summary.version).toBe("3");
    expect(store.getSnapshot().report?.entries.get(0)?.state).toBe("landed");
  });
});
