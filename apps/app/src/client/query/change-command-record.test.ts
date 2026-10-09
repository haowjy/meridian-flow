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
  queueChangeSelection,
  readPreviewAfterChangeCommands,
} from "./change-command-record";
import {
  beginDraftCommand,
  releaseDraftCommand,
  resetDraftCommandRecords,
} from "./draft-command-record";

const draft = { projectId: "p", workId: "w", documentId: "d", draftId: "x" };
const one = { classIds: ["c1"], operationIds: ["1"] };
const two = { classIds: ["c2"], operationIds: ["2", "3"] };

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
      changeCommandState(records, draft, { classIds: ["c9"], operationIds: ["3"] }),
    ).toMatchObject({ phase: "pending" });
  });

  it("a queued selection hides its operations without claiming the draft, until it is retired", () => {
    const retire = queueChangeSelection(draft, two);
    const records = currentChangeCommandRecords();
    expect([...hiddenOperationIds(records, draft)]).toEqual(["2", "3"]);
    // Another draft is untouched, and the queue blocks no command.
    expect(hiddenOperationIds(records, { ...draft, draftId: "y" }).size).toBe(0);
    expect(changeCommandState(records, draft, two)).toBeNull();
    expect(beginChangeCommand(draft, one, "apply")).toBe(true);
    releaseDraftCommand(draft);
    retire();
    retire();
    expect(hiddenOperationIds(currentChangeCommandRecords(), draft).size).toBe(0);
  });

  it("retiring one queued selection leaves another of the same draft hidden", () => {
    const retireOne = queueChangeSelection(draft, one);
    queueChangeSelection(draft, two);
    retireOne();
    expect([...hiddenOperationIds(currentChangeCommandRecords(), draft)]).toEqual(["2", "3"]);
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

  it("never hides a hunk no operation owns (an unclassified one)", () => {
    const base = preview();
    if (base.status !== "active") throw new Error("active");
    const loose = {
      kind: "text",
      hunkId: "h-loose",
      operationIds: [],
      unclassified: true,
      anchor: { relStart: "", relEnd: "" },
      spans: [],
    } as const;
    const hidden = previewWithoutOperations(
      { ...base, hunks: [...base.hunks, loose] } as DraftPreviewResponse,
      new Set(["1", "2", "3"]),
    );
    if (hidden.status !== "active") throw new Error("active");
    expect(hidden.hunks.map((h) => h.hunkId)).toEqual(["h-loose"]);
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

  describe("a selection of several changes", () => {
    const both = { classIds: ["c1", "c2"], operationIds: ["1", "2", "3"] };

    it("holds one failure per selection, shown on the file and on each change it overlaps", () => {
      failChangeCommand(draft, both, "apply", "stale");
      failChangeCommand(draft, both, "apply", "offline");
      const records = currentChangeCommandRecords();
      expect(Object.keys(records.changes)).toHaveLength(1);
      expect(changeCommandState(records, draft, both)).toMatchObject({ code: "offline" });
      expect(changeCommandState(records, draft, one)).toMatchObject({ code: "offline" });
      expect(changeCommandState(records, draft, two)).toMatchObject({ code: "offline" });
      // Another draft, and a change the selection did not name, show nothing.
      expect(changeCommandState(records, { ...draft, draftId: "y" }, both)).toBeNull();
      expect(
        changeCommandState(records, draft, { classIds: ["c9"], operationIds: ["9"] }),
      ).toBeNull();
    });

    it("clears on the next action on one of its changes, and once a read lists none of them", async () => {
      failChangeCommand(draft, both, "discard", "stale");
      beginChangeCommand(draft, one, "apply");
      expect(Object.keys(currentChangeCommandRecords().changes)).toEqual([]);
      releaseDraftCommand(draft);

      failChangeCommand(draft, both, "discard", "stale");
      await readPreviewAfterChangeCommands(draft, async () => preview());
      expect(changeCommandState(currentChangeCommandRecords(), draft, both)).not.toBeNull();
      await readPreviewAfterChangeCommands(draft, async () =>
        previewWithoutOperations(preview(), new Set(["1", "2", "3"])),
      );
      expect(changeCommandState(currentChangeCommandRecords(), draft, both)).toBeNull();
    });

    it("hides every operation of the selection while its claim is held, and a confirmation fences reads", async () => {
      beginChangeCommand(draft, both, "apply");
      expect([...hiddenOperationIds(currentChangeCommandRecords(), draft)]).toEqual([
        "1",
        "2",
        "3",
      ]);
      releaseDraftCommand(draft);
      let finish!: (value: DraftPreviewResponse) => void;
      const read = readPreviewAfterChangeCommands(
        draft,
        () => new Promise<DraftPreviewResponse>((resolve) => (finish = resolve)),
      );
      confirmChangeCommand(draft, both, "apply");
      finish(preview());
      expect(operationIds(await read)).toEqual([]);
    });
  });

  describe("a change the server regroups", () => {
    const a = { classIds: ["closure:1"], operationIds: ["1"] };
    const b = { classIds: ["closure:1+2"], operationIds: ["1", "2"] };
    const c = { classIds: ["closure:1+2+3"], operationIds: ["1", "2", "3"] };

    it("retires the failure held under its old class when the writer acts again", () => {
      failChangeCommand(draft, a, "apply", "stale");
      expect(beginChangeCommand(draft, b, "discard")).toBe(true);
      expect(Object.keys(currentChangeCommandRecords().changes)).toEqual([]);
    });

    it("shows the latest failure, however many times it was regrouped since", () => {
      failChangeCommand(draft, a, "apply", "stale");
      beginChangeCommand(draft, b, "discard");
      failChangeCommand(draft, b, "discard", "refused", {
        serverCode: "work_archived",
        serverReason: "The server's reason",
      });
      releaseDraftCommand(draft);
      expect(changeCommandState(currentChangeCommandRecords(), draft, c)).toMatchObject({
        mode: "discard",
        code: "refused",
        serverCode: "work_archived",
        serverReason: "The server's reason",
      });
    });

    it("shows the newest of several failures that still apply, not the first held", () => {
      failChangeCommand(draft, a, "apply", "stale");
      failChangeCommand(
        draft,
        { classIds: ["closure:2"], operationIds: ["2"] },
        "discard",
        "offline",
      );
      expect(changeCommandState(currentChangeCommandRecords(), draft, b)).toMatchObject({
        mode: "discard",
        code: "offline",
      });
    });

    it("leaves the failures of unrelated changes alone", () => {
      failChangeCommand(draft, { classIds: ["closure:9"], operationIds: ["9"] }, "apply", "stale");
      beginChangeCommand(draft, b, "discard");
      expect(Object.keys(currentChangeCommandRecords().changes)).toHaveLength(1);
    });
  });
});
