import { i18n } from "@lingui/core";
import type { ImportEntryReport, ImportFinding } from "@meridian/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ImportState } from "./import-state";
import { buildReportModel } from "./report-model";

const entry = (
  entryId: number,
  patch: Partial<ImportEntryReport> & { findings?: ImportFinding[] },
): ImportEntryReport => ({
  entryId,
  rootId: 0,
  path: `n${entryId}.md`,
  filename: `n${entryId}.md`,
  size: 1,
  sha256: "x",
  documentId: `d${entryId}`,
  kind: "note",
  state: "landed",
  uri: `kb://vault/n${entryId}`,
  name: `n${entryId}`,
  reason: null,
  exists: true,
  findings: [],
  ...patch,
});

function stateOf(entries: ImportEntryReport[], finished = true): ImportState {
  return {
    importId: "i",
    report: {
      summary: { state: finished ? "finished" : "ready", counts: {} } as never,
      roots: [{ rootId: 0, kind: "folder", name: "vault", id: "f", uri: "kb://vault/" }],
      entries: new Map(entries.map((e) => [e.entryId, e])),
      cursor: "1",
    },
    local: null,
    load: "idle",
    refreshFailed: false,
    dismissing: false,
    dismissFailed: false,
    activitySeenAt: null,
    stop: "none",
  };
}

describe("buildReportModel", () => {
  beforeAll(() => i18n.loadAndActivate({ locale: "en", messages: {} }));

  it("puts failures, findings, renames and skips in their own sections", () => {
    const model = buildReportModel(
      stateOf([
        entry(0, { state: "failed", reason: "conversion_failed" }),
        entry(1, { findings: [{ code: "hidden_notes", params: { count: 2 } }] }),
        entry(2, { findings: [{ code: "folder_note", params: {} }] }),
        entry(3, {
          state: "skipped",
          reason: "obsidian_canvas",
          uri: null,
          exists: false,
          path: "Plot.canvas",
          filename: "Plot.canvas",
        }),
        entry(4, { state: "skipped", reason: "trash", uri: null, exists: false }),
        entry(5, { state: "skipped", reason: "trash", uri: null, exists: false }),
      ]),
    );
    expect(model.failed.map((row) => row.entry.entryId)).toEqual([0]);
    expect(model.worthALook.map((group) => group.group)).toEqual(["hidden"]);
    expect(model.renamed).toHaveLength(1);
    expect(model.skipped.map((line) => [line.reason, line.count])).toEqual([
      ["obsidian_canvas", 1],
      ["trash", 2],
    ]);
  });

  it("splits what a stopped import left into empty documents, what the writer wrote and never created", () => {
    const model = buildReportModel(
      stateOf([
        entry(0, { state: "not_imported" }),
        entry(1, { state: "not_imported", reason: "edited_before_arrival" }),
        entry(2, { state: "not_imported", exists: false, kind: "binary", uri: null }),
        entry(3, { state: "deleted", reason: "deleted_before_arrival" }),
      ]),
    );
    expect(model.notImported.emptyKept.map((row) => row.entry.entryId)).toEqual([0]);
    expect(model.notImported.keptWithWrote.map((row) => row.entry.entryId)).toEqual([1]);
    expect(model.notImported.neverCreated.map((row) => row.entry.entryId)).toEqual([2]);
    expect(model.notImported.deleted.map((row) => row.entry.entryId)).toEqual([3]);
  });

  it("shows one Obsidian settings line per folder however many notes carry it", () => {
    const finding: ImportFinding = { code: "settings_unreadable", params: { name: "vault" } };
    const model = buildReportModel(
      stateOf([entry(0, { findings: [finding] }), entry(1, { findings: [finding] })]),
    );
    expect(model.worthALook.find((group) => group.group === "settings")?.rows).toHaveLength(1);
  });

  it("keeps a code it does not know under other things to check", () => {
    const model = buildReportModel(
      stateOf([entry(0, { findings: [{ code: "from_the_future", params: {} } as never] })]),
    );
    expect(model.worthALook.map((group) => group.group)).toEqual(["other"]);
  });
});
