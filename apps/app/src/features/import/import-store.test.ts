/** One import's passive store: the entry cursor only moves past changes it has applied. */
import type { ImportEntryStatus, ImportStatus, ImportSummary } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { ImportStore } from "./import-store";

const planned: ImportEntryStatus = {
  entryId: 0,
  rootId: 0,
  path: "",
  filename: "Ch 1.md",
  size: 1,
  sha256: "a".repeat(64),
  documentId: "doc-0",
  kind: "note",
  state: "planned",
  name: "Ch 1",
  reason: null,
  parentId: null,
  scheme: "kb",
  extension: "",
  wanted: false,
};
const landed: ImportEntryStatus = { ...planned, state: "landed" };

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
  };
}

function report(version: string, entries: ImportEntryStatus[]): ImportStatus {
  return {
    ...summary(version),
    roots: [{ rootId: 0, kind: "file", name: "Ch 1.md", id: null }],
    folders: [],
    entries,
  };
}

describe("ImportStore", () => {
  it("applies a cut on top of a full read and adopts a root's new id", () => {
    const store = new ImportStore("p", "import-1");
    store.installReport(report("1", [planned]));
    store.seedSummary(summary("2", "finished"));
    // A newer summary alone does not move the cursor past changes not yet read.
    expect(store.getSnapshot().report?.cursor).toBe("1");

    store.applyChanges({
      ...summary("2", "finished"),
      roots: [{ rootId: 0, kind: "file", name: "Ch 1.md", id: "doc-0" }],
      folders: [],
      entries: [landed],
    });

    expect(store.getSnapshot().report?.cursor).toBe("2");
    expect(store.getSnapshot().report?.entries.get(0)?.state).toBe("landed");
    expect(store.getSnapshot().report?.roots[0]?.id).toBe("doc-0");
  });

  it("never lets an older answer replace a newer one", () => {
    const store = new ImportStore("p", "import-1");
    store.installReport({ ...report("3", [landed]), state: "finished" });
    store.installReport(report("1", [planned]));

    expect(store.getSnapshot().report?.summary.version).toBe("3");
    expect(store.getSnapshot().report?.entries.get(0)?.state).toBe("landed");
  });
});
