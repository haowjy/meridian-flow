// @vitest-environment jsdom
/** The command records are bounded: scoped to a Work, retired with the reads they fence, and emptied per account. */
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  answerDraftCommandClosed,
  beginDraftCommand,
  bindDraftCommandAccount,
  confirmDraftCommand,
  draftCommandFailure,
  draftCommandPendingIn,
  failDraftCommand,
  pendingChangeCommand,
  readDraftsAfterCommands,
  releaseDraftCommand,
  resetDraftCommandRecords,
  useDraftCommandRecords,
} from "./draft-command-record";

const scope = { projectId: "project-a", workId: "work-a" };
const draft = { ...scope, documentId: "doc-a", draftId: "draft-a" };
const listed = [{ documentId: "doc-a", draftId: "draft-a" }];

let held: ReturnType<typeof useDraftCommandRecords> = {};
function Capture() {
  held = useDraftCommandRecords();
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
  beforeEach(() => resetDraftCommandRecords());

  it("disables only the Work the command is in, and arbitrates the same draft", async () => {
    await run(async () => {
      await act(async () => void beginDraftCommand(draft));
      expect(draftCommandPendingIn(held, scope)).toBe(true);
      expect(draftCommandPendingIn(held, { ...scope, workId: "work-b" })).toBe(false);
      expect(draftCommandPendingIn(held, { ...scope, projectId: "project-b" })).toBe(false);
      expect(beginDraftCommand(draft)).toBe(false);
      expect(beginDraftCommand({ ...draft, workId: "work-b" })).toBe(true);
    });
  });

  it("retires a confirmation once no earlier read is left, so a reused draft id is admitted", async () => {
    await run(async () => {
      const earlier = deferred<typeof listed>();
      const read = readDraftsAfterCommands(scope, () => earlier.promise);
      await act(async () => confirmDraftCommand(draft));
      expect(Object.keys(held)).toHaveLength(1);
      earlier.resolve(listed);
      expect(await read).toEqual([]);
      await act(async () => undefined);
      expect(held).toEqual({});
      // The next generation of proposals reuses the id; a later read sees it.
      expect(await readDraftsAfterCommands(scope, async () => listed)).toEqual(listed);
      // With no read in flight, a confirmation leaves nothing behind at all.
      await act(async () => confirmDraftCommand(draft));
      expect(held).toEqual({});
    });
  });

  it("keeps nothing of the answer that closed the draft once the claim is released, even with a read in flight", async () => {
    await run(async () => {
      const closing = { classIds: ["c"], operationIds: ["1"], mode: "discard" as const };
      const earlier = deferred<typeof listed>();
      const read = readDraftsAfterCommands(scope, () => earlier.promise);
      await act(async () => {
        beginDraftCommand(draft, {
          ...closing,
          draftGeneration: 1,
          completesDraft: true,
        });
        answerDraftCommandClosed(draft, { documentName: "Chapter 13" });
      });
      expect(pendingChangeCommand(held, draft)?.draftClosed).toEqual({
        documentName: "Chapter 13",
      });
      expect(draftCommandPendingIn(held, scope)).toBe(true);
      await act(async () => releaseDraftCommand(draft));
      // The server reuses the id for the next proposal: the answer is gone with the claim.
      expect(pendingChangeCommand(held, draft)).toBeNull();
      expect(held).toEqual({});
      earlier.resolve(listed);
      await read;
    });
  });

  it("drops a failure when a later read no longer lists the draft, never carrying it forward", async () => {
    await run(async () => {
      await act(async () => failDraftCommand(draft, { code: "discard-offline" }));
      await readDraftsAfterCommands(scope, async () => listed);
      await act(async () => undefined);
      expect(draftCommandFailure(held, draft)).toEqual({ code: "discard-offline" });
      await readDraftsAfterCommands(scope, async () => []);
      await act(async () => undefined);
      expect(held).toEqual({});

      // A failure newer than the read that omits it belongs to a draft the read never saw.
      const stale = deferred<typeof listed>();
      const read = readDraftsAfterCommands(scope, () => stale.promise);
      await act(async () => failDraftCommand(draft, { code: "apply-unknown" }));
      stale.resolve([]);
      await read;
      await act(async () => undefined);
      expect(draftCommandFailure(held, draft)).toEqual({ code: "apply-unknown" });
    });
  });

  it("empties the store only when a different account binds", async () => {
    await run(async () => {
      await act(async () => {
        bindDraftCommandAccount("account-a");
        failDraftCommand(draft, { code: "discard-offline" });
        bindDraftCommandAccount("account-a");
      });
      expect(draftCommandFailure(held, draft)).toEqual({ code: "discard-offline" });
      await act(async () => bindDraftCommandAccount("account-b"));
      expect(held).toEqual({});
    });
  });
});
