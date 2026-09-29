/** The Work list's rows per tab, from the projected Works and their command records. */
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import type { WorkRowFailure } from "./WorkCommandFailureRow";
import { type WorkListProjection, workListEntries } from "./work-list-model";

const NOW = Date.parse("2026-09-10T00:00:00.000Z");
const work = (id: string, fields: Partial<Work> = {}) =>
  ({
    id,
    name: id,
    goal: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    ...fields,
  }) as Work;
const deleted = (id: string, fields: Partial<Work> = {}) =>
  work(id, { deletedAt: "2026-09-09T00:00:00.000Z", ...fields });
const failure = (workId: string, operation: WorkRowFailure["operation"]) =>
  ({
    workId,
    operation,
    error: new Error("Rejected"),
    retry: async () => null,
    dismiss: () => {},
  }) as WorkRowFailure;

const projection = (fields: Partial<WorkListProjection>): WorkListProjection => ({
  works: [],
  deleted: [],
  creations: new Map(),
  restoring: new Set(),
  ...fields,
});
const shape = (
  entries: ReturnType<typeof workListEntries>[keyof ReturnType<typeof workListEntries>],
) => entries.map(({ key, state, failure }) => [key, state, failure?.operation ?? null]);

describe("workListEntries", () => {
  it("puts Works being created first, then Undo rows newest first, then the tab's Works", () => {
    const entries = workListEntries(
      projection({
        works: [work("arc"), work("coda", { status: "archived" }), work("draft")],
        deleted: [
          deleted("gone-2"),
          deleted("gone-1"),
          deleted("gone-archived", { status: "archived" }),
        ],
        creations: new Map([
          ["new", { work: work("new"), phase: "pending" }],
          ["refused", { work: work("refused"), phase: "failed" }],
        ]),
        restoring: new Set(["draft"]),
      }),
      [{ workId: "gone-1" }, { workId: "gone-2" }, { workId: "gone-archived" }],
      new Map([
        ["arc", failure("arc", "archive")],
        ["gone-1", failure("gone-1", "restore")],
      ]),
      NOW,
    );
    expect(shape(entries.active)).toEqual([
      ["new", "creating", null],
      ["refused", "notCreated", null],
      ["deleted-gone-2", "undo", null],
      ["deleted-gone-1", "undo", "restore"],
      ["arc", "idle", "archive"],
      ["draft", "restoring", null],
    ]);
    expect(shape(entries.archived)).toEqual([
      ["deleted-gone-archived", "undo", null],
      ["coda", "idle", null],
    ]);
    // Works offered for Undo stay out of the Deleted tab.
    expect(entries.deleted).toEqual([]);
  });

  it("lists restorable deleted Works with their restore failure, and drops purged ones", () => {
    const entries = workListEntries(
      projection({
        deleted: [deleted("recent"), deleted("purged", { deletedAt: "2026-07-01T00:00:00.000Z" })],
      }),
      [],
      new Map([["recent", failure("recent", "restore")]]),
      NOW,
    );
    expect(shape(entries.deleted)).toEqual([["recent", "idle", "restore"]]);
    expect(entries.active).toEqual([]);
  });

  it("gives a restoring Work no failure row", () => {
    const entries = workListEntries(
      projection({ works: [work("arc")], restoring: new Set(["arc"]) }),
      [],
      new Map([["arc", failure("arc", "delete")]]),
      NOW,
    );
    expect(shape(entries.active)).toEqual([["arc", "restoring", null]]);
  });
});
