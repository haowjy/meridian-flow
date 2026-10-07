/**
 * The change command record: what a preview read may bring back after the
 * writer applied or discarded a change, and what a held failure follows.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  beginChangeCommand,
  changeCommandState,
  clearChangeFailure,
  confirmChangeCommand,
  currentChangeCommandRecords,
  failChangeCommand,
  hiddenOperationIds,
  previewWithoutOperations,
  readPreviewAfterChangeCommands,
} from "./change-command-record";
import { beginDraftCommand, resetDraftCommandRecords } from "./draft-command-record";

const draft = { projectId: "p", workId: "w", documentId: "d", draftId: "x" };
const one = { classId: "c1", operationIds: ["1"] };
const two = { classId: "c2", operationIds: ["2", "3"] };

function preview(): DraftPreviewResponse {
  const op = (operationId: string, closureClassId: string) => ({
    operationId,
    closureClassId,
    kind: "agent" as const,
    contribution: "added" as const,
    classification: "addition" as const,
    hunkCount: 1,
  });
  return {
    status: "active",
    draftId: "x",
    reviewRoomName: "room",
    live: "",
    preview: "",
    liveRevisionToken: "l",
    draftRevisionToken: "t",
    inlineModelPresent: true,
    operations: [op("1", "c1"), op("2", "c2"), op("3", "c2")],
    hunks: [
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["1"],
        anchor: { relStart: "", relEnd: "" },
        spans: [],
      },
      {
        kind: "text",
        hunkId: "h2",
        operationIds: ["2", "3"],
        anchor: { relStart: "", relEnd: "" },
        spans: [
          { operationId: "2", anchorFrom: "", anchorTo: "" },
          { operationId: "3", anchorFrom: "", anchorTo: "" },
        ],
      },
    ],
  };
}

const operationIds = (p: DraftPreviewResponse) =>
  p.status === "active" ? p.operations.map((o) => o.operationId) : [];

describe("change command record", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("claims the draft once: no second change, and no whole-draft command, beside it", () => {
    expect(beginChangeCommand(draft, one, "apply")).toBe(true);
    expect(beginChangeCommand(draft, one, "discard")).toBe(false);
    expect(beginChangeCommand(draft, two, "apply")).toBe(false);
    expect(beginDraftCommand(draft)).toBe(false);
    expect(beginChangeCommand({ ...draft, draftId: "y" }, two, "apply")).toBe(true);
  });

  it("a claim hides its operations and is the change's pending state", () => {
    beginChangeCommand(draft, two, "discard");
    const records = currentChangeCommandRecords();
    expect([...hiddenOperationIds(records, draft)]).toEqual(["2", "3"]);
    expect(changeCommandState(records, draft, two)).toEqual({ phase: "pending", mode: "discard" });
    // Found by a shared operation too, as the server may regroup the class.
    expect(
      changeCommandState(records, draft, { classId: "c9", operationIds: ["3"] }),
    ).toMatchObject({ phase: "pending" });
  });

  it("a read that started before a confirmation cannot bring the change back", async () => {
    let finish!: (value: DraftPreviewResponse) => void;
    const read = readPreviewAfterChangeCommands(
      draft,
      () => new Promise<DraftPreviewResponse>((resolve) => (finish = resolve)),
    );
    beginChangeCommand(draft, one, "apply");
    confirmChangeCommand(draft, one, "apply");
    finish(preview());
    expect(operationIds(await read)).toEqual(["2", "3"]);
    // The read settled, so nothing is left to fence.
    expect(Object.keys(currentChangeCommandRecords().changes)).toHaveLength(0);
  });

  it("a read that started after the confirmation is authoritative", async () => {
    confirmChangeCommand(draft, one, "apply");
    const after = await readPreviewAfterChangeCommands(draft, async () => preview());
    expect(operationIds(after)).toEqual(["1", "2", "3"]);
  });

  it("a failure is dropped once a read no longer lists any of the change's operations", async () => {
    failChangeCommand(draft, one, "apply", "offline");
    expect(changeCommandState(currentChangeCommandRecords(), draft, one)?.phase).toBe("failed");
    const without = previewWithoutOperations(preview(), new Set(["1"]));
    await readPreviewAfterChangeCommands(draft, async () => without);
    expect(changeCommandState(currentChangeCommandRecords(), draft, one)).toBeNull();
  });

  it("a failure survives a read that still lists the change, and clears on the next action", async () => {
    failChangeCommand(draft, one, "apply", "stale");
    await readPreviewAfterChangeCommands(draft, async () => preview());
    expect(changeCommandState(currentChangeCommandRecords(), draft, one)).toMatchObject({
      code: "stale",
    });
    clearChangeFailure(draft, one);
    expect(changeCommandState(currentChangeCommandRecords(), draft, one)).toBeNull();
  });

  it("hides a change's operations and the hunks only they own, nothing else", () => {
    const hidden = previewWithoutOperations(preview(), new Set(["2", "3"]));
    if (hidden.status !== "active") throw new Error("active");
    expect(hidden.operations.map((o) => o.operationId)).toEqual(["1"]);
    expect(hidden.hunks.map((h) => h.hunkId)).toEqual(["h1"]);
  });

  it("keeps the same preview object when nothing is hidden", () => {
    const original = preview();
    expect(previewWithoutOperations(original, new Set())).toBe(original);
  });

  it("belongs to its draft: another draft's changes are untouched", () => {
    beginChangeCommand(draft, one, "apply");
    const other = { ...draft, draftId: "y" };
    expect(changeCommandState(currentChangeCommandRecords(), other, one)).toBeNull();
  });
});
