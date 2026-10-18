// @vitest-environment jsdom
/** The command records are bounded: scoped to a Work, retained for cached observations, and emptied per account. */
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  answerBranchCommandClosed,
  beginBranchCommand,
  bindBranchCommandAccount,
  branchCommandFailure,
  confirmBranchCommand,
  currentChangeCommandRecords,
  failBranchCommand,
  pendingChangeCommand,
  readBranchesAfterCommands,
  releaseBranchCommand,
  resetBranchCommandRecords,
  shareDraftObservation,
  useBranchCommandRecords,
} from "./branch-command-record";

import { projectDraftList } from "./draft-projection";

const scope = { projectId: "project-a", workId: "work-a" };
const draft = { ...scope, documentId: "doc-a", itemKey: "draft-a" };
const listed = [{ documentId: "doc-a", itemKey: "draft-a" }];

let held: ReturnType<typeof useBranchCommandRecords> = {};
function Capture() {
  held = useBranchCommandRecords();
  return null;
}
const run = (body: () => Promise<void>) => withReactRoot(<Capture />, body);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("draft command records", () => {
  beforeEach(() => resetBranchCommandRecords());

  it("retains raw list evidence and generation-addressed Apply intent after overlapping reads", async () => {
    await run(async () => {
      const rows = [{ ...listed[0], draftGeneration: 5 }];
      const earlier = deferred<typeof rows>();
      const later = deferred<typeof rows>();
      const read = readBranchesAfterCommands(scope, () => earlier.promise);
      const secondRead = readBranchesAfterCommands(scope, () => later.promise);
      const visible = (observed: typeof rows) =>
        projectDraftList(observed, scope, currentChangeCommandRecords());
      await act(async () =>
        beginBranchCommand(draft, { target: "all", mode: "apply", draftGeneration: 5 }),
      );
      expect(visible(rows)).toEqual([]);
      await act(async () => confirmBranchCommand(draft));
      earlier.resolve(rows);
      expect(await read).toBe(rows);
      expect(visible(rows)).toEqual([]);
      later.resolve(rows);
      expect(await secondRead).toBe(rows);
      expect(visible(rows)).toEqual([]);
      const fresh = rows.map((row) => ({ ...row }));
      expect(await readBranchesAfterCommands(scope, async () => fresh)).toBe(fresh);
      expect(shareDraftObservation(rows, fresh)).toBe(fresh);
      expect(visible(fresh)).toEqual(fresh);
      expect(visible(rows)).toEqual([]);
      const successor = [{ ...rows[0], draftGeneration: 6 }];
      expect(visible(successor)).toEqual(successor);
      // A later failure, observation omission or release cannot erase the older intent.
      await act(async () => {
        beginBranchCommand(draft, { target: "all", mode: "apply", draftGeneration: 6 });
        failBranchCommand(draft, { code: "apply-offline" });
      });
      await act(async () => {
        await readBranchesAfterCommands(scope, async () => []);
      });
      expect(visible(rows)).toEqual([]);
      expect(visible(successor)).toEqual(successor);
      await act(async () => resetBranchCommandRecords());
      expect(visible(rows)).toEqual(rows);
    });
  });

  it("keeps nothing of the answer that closed the draft once the claim is released, even with a read in flight", async () => {
    await run(async () => {
      const closing = {
        classIds: ["c"],
        admissionTokens: ["c"],
        operationIds: ["1"],
        mode: "discard" as const,
      };
      const earlier = deferred<typeof listed>();
      const read = readBranchesAfterCommands(scope, () => earlier.promise);
      await act(async () => {
        beginBranchCommand(draft, {
          ...closing,
          target: "selection",
          draftGeneration: 1,
          completesDraft: true,
        });
        answerBranchCommandClosed(draft, { documentName: "Chapter 13" });
      });
      expect(pendingChangeCommand(held, draft)?.itemClosed).toEqual({
        documentName: "Chapter 13",
      });
      await act(async () => releaseBranchCommand(draft));
      // The server reuses the id for the next proposal: the answer is gone with the claim.
      expect(pendingChangeCommand(held, draft)).toBeNull();
      expect(held).toEqual({});
      earlier.resolve(listed);
      await read;
    });
  });

  it("drops a failure when a later read no longer lists the draft, never carrying it forward", async () => {
    await run(async () => {
      await act(async () => failBranchCommand(draft, { code: "discard-offline" }));
      await readBranchesAfterCommands(scope, async () => listed);
      await act(async () => undefined);
      expect(branchCommandFailure(held, draft)).toEqual({ code: "discard-offline" });
      await readBranchesAfterCommands(scope, async () => []);
      await act(async () => undefined);
      expect(held).toEqual({});

      // A failure newer than the read that omits it belongs to a draft the read never saw.
      const stale = deferred<typeof listed>();
      const read = readBranchesAfterCommands(scope, () => stale.promise);
      await act(async () => failBranchCommand(draft, { code: "apply-unknown" }));
      stale.resolve([]);
      await read;
      await act(async () => undefined);
      expect(branchCommandFailure(held, draft)).toEqual({ code: "apply-unknown" });
    });
  });

  it("empties the store only when a different account binds", async () => {
    await run(async () => {
      await act(async () => {
        bindBranchCommandAccount("account-a");
        failBranchCommand(draft, { code: "discard-offline" });
        bindBranchCommandAccount("account-a");
      });
      expect(branchCommandFailure(held, draft)).toEqual({ code: "discard-offline" });
      await act(async () => bindBranchCommandAccount("account-b"));
      expect(held).toEqual({});
    });
  });
});
