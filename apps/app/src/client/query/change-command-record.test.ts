/**
 * The change command record: what a preview read may bring back after the
 * writer applied or discarded a change, and what a held failure follows.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  beginChangeCommand,
  changeCommandState,
  confirmChangeCommand,
  currentChangeCommandRecords,
  failChangeCommand,
  hiddenOperationIds,
  previewWithoutOperations,
  queueChangeSelection,
  readPreviewAfterChangeCommands,
} from "./change-command-record";
import { releaseDraftCommand, resetDraftCommandRecords } from "./draft-command-record";

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
    draftGeneration: 1,
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
    beginChangeCommand(draft, one, "apply", 1);
    confirmChangeCommand(draft, one, "apply");
    finish(preview());
    expect(operationIds(await read)).toEqual(["2", "3"]);
    // The read settled, so nothing is left to fence.
    expect(Object.keys(currentChangeCommandRecords().changes)).toHaveLength(0);
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
      beginChangeCommand(draft, one, "apply", 1);
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
      beginChangeCommand(draft, both, "apply", 1);
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
      expect(beginChangeCommand(draft, b, "discard", 1)).toBe(true);
      expect(Object.keys(currentChangeCommandRecords().changes)).toEqual([]);
    });

    it("shows the latest failure, however many times it was regrouped since", () => {
      failChangeCommand(draft, a, "apply", "stale");
      beginChangeCommand(draft, b, "discard", 1);
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
      beginChangeCommand(draft, b, "discard", 1);
      expect(Object.keys(currentChangeCommandRecords().changes)).toHaveLength(1);
    });
  });
});
