/**
 * The change command record: what a preview read may bring back after the
 * writer applied or discarded a change, and what a held failure follows.
 */

import type { DraftPreviewResponse } from "@meridian/contracts/branches";
import { beforeEach, describe, expect, it } from "vitest";
import { listed } from "@/test-support/draft-review-scope";
import {
  beginChangeCommand,
  changeCommandState,
  currentChangeCommandRecords,
  failChangeCommand,
  readPreviewAfterChangeCommands,
  releaseBranchCommand,
  resetBranchCommandRecords,
} from "./branch-command-record";
import { previewWithoutKeys } from "./draft-projection";

const draft = { projectId: "p", workId: "w", documentId: "d", itemKey: "x" };
const one = { classIds: ["c1"], admissionTokens: ["c1"], operationIds: ["1"] };
const two = { classIds: ["c2"], admissionTokens: ["c2"], operationIds: ["2", "3"] };

function preview(): DraftPreviewResponse {
  const op = (operationId: string, closureClassId: string) => ({
    operationId,
    closureClassId,
    admissionToken: closureClassId,
    kind: "agent" as const,
    classification: "addition" as const,
  });
  return {
    status: "active",
    branchId: "d",
    item: { ...listed, itemKey: "x" },
    itemKey: "x",
    draftGeneration: 1,
    reviewRoomName: "room",

    liveRevisionToken: "l",
    draftRevisionToken: "t",
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

describe("change command record", () => {
  beforeEach(() => resetBranchCommandRecords());

  describe("a selection of several changes", () => {
    const both = {
      classIds: ["c1", "c2"],
      admissionTokens: ["c1", "c2"],
      operationIds: ["1", "2", "3"],
    };

    it("holds one failure per selection, shown on the file and on each change it overlaps", () => {
      failChangeCommand(draft, both, "apply", "stale");
      failChangeCommand(draft, both, "apply", "offline");
      const records = currentChangeCommandRecords();
      expect(changeCommandState(records, draft, both)).toMatchObject({ code: "offline" });
      expect(changeCommandState(records, draft, one)).toMatchObject({ code: "offline" });
      expect(changeCommandState(records, draft, two)).toMatchObject({ code: "offline" });
      // Another draft, and a change the selection did not name, show nothing.
      expect(changeCommandState(records, { ...draft, itemKey: "y" }, both)).toBeNull();
      expect(
        changeCommandState(records, draft, {
          classIds: ["c9"],
          admissionTokens: ["c9"],
          operationIds: ["9"],
        }),
      ).toBeNull();
    });

    it("clears on the next action on one of its changes, and once a read lists none of them", async () => {
      failChangeCommand(draft, both, "discard", "stale");
      beginChangeCommand(draft, one, "apply", 1);
      expect(changeCommandState(currentChangeCommandRecords(), draft, both)).not.toMatchObject({
        phase: "failed",
      });
      releaseBranchCommand(draft);

      failChangeCommand(draft, both, "discard", "stale");
      await readPreviewAfterChangeCommands(draft, async () => preview());
      expect(changeCommandState(currentChangeCommandRecords(), draft, both)).not.toBeNull();
      await readPreviewAfterChangeCommands(draft, async () =>
        previewWithoutKeys(preview(), new Set(["row:1", "row:2", "row:3"])),
      );
      expect(changeCommandState(currentChangeCommandRecords(), draft, both)).toBeNull();
    });
  });

  describe("a change the server regroups", () => {
    const a = { classIds: ["closure:1"], admissionTokens: ["closure:1"], operationIds: ["1"] };
    const b = {
      classIds: ["closure:1+2"],
      admissionTokens: ["closure:1+2"],
      operationIds: ["1", "2"],
    };
    const c = {
      classIds: ["closure:1+2+3"],
      admissionTokens: ["closure:1+2+3"],
      operationIds: ["1", "2", "3"],
    };

    it("retires the failure held under its old class when the writer acts again", () => {
      failChangeCommand(draft, a, "apply", "stale");
      expect(beginChangeCommand(draft, b, "discard", 1)).not.toBeNull();
      expect(changeCommandState(currentChangeCommandRecords(), draft, a)).not.toMatchObject({
        phase: "failed",
      });
    });

    it("shows the latest failure, however many times it was regrouped since", () => {
      failChangeCommand(draft, a, "apply", "stale");
      beginChangeCommand(draft, b, "discard", 1);
      failChangeCommand(draft, b, "discard", "refused", {
        serverCode: "work_archived",
        serverReason: "The server's reason",
      });
      releaseBranchCommand(draft);
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
        { classIds: ["closure:2"], admissionTokens: ["closure:2"], operationIds: ["2"] },
        "discard",
        "offline",
      );
      expect(changeCommandState(currentChangeCommandRecords(), draft, b)).toMatchObject({
        mode: "discard",
        code: "offline",
      });
    });

    it("leaves the failures of unrelated changes alone", () => {
      failChangeCommand(
        draft,
        { classIds: ["closure:9"], admissionTokens: ["closure:9"], operationIds: ["9"] },
        "apply",
        "stale",
      );
      beginChangeCommand(draft, b, "discard", 1);
      expect(
        changeCommandState(currentChangeCommandRecords(), draft, {
          classIds: ["closure:9"],
          admissionTokens: ["closure:9"],
          operationIds: ["9"],
        }),
      ).toMatchObject({ code: "stale" });
    });
  });
});
