/**
 * One command authority per draft, across sessions. The Editor and the Chat
 * each own a session over the same Work, so a command one sends must be seen by
 * the other: opposing commands for one draft are never both sent.
 */
import type { DraftApplyChangesResponse } from "@meridian/contracts/drafts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  changeCommandState,
  currentChangeCommandRecords,
} from "@/client/query/change-command-record";
import {
  currentDraftCommandRecords,
  draftCommandFailure,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { type DraftReviewCommandPorts, DraftReviewSession } from "./draft-review-session";

const scope = { projectId: "p", workId: "w" };
const selection = { documentId: "doc", draftId: "draft" };
const draft = { ...scope, ...selection };
const change = { classIds: ["class"], operationIds: ["1", "2"] };
const otherChange = { classIds: ["other"], operationIds: ["3"] };
const tokens = { liveRevisionToken: "live-1", draftRevisionToken: "draft-1" };
const applied: DraftApplyChangesResponse = {
  status: "applied",
  draftId: "draft",
  operationIds: ["1", "2"],
  closureClassIds: ["class"],
};

/** Two sessions on one Work, as the Editor and the Chat are, sharing every port. */
function twoSessions() {
  let answerChange!: (response: DraftApplyChangesResponse) => void;
  let answerApply!: (result: "applied" | "unknown") => void;
  let rejectApply!: (error: Error) => void;
  const ports = {
    scope,
    apply: vi.fn(
      () =>
        new Promise<"applied" | "unknown">((resolve, reject) => {
          answerApply = resolve;
          rejectApply = reject;
        }),
    ),
    discard: vi.fn(async () => {}),
    discardChanges: vi.fn(),
    applyChanges: vi.fn(
      () => new Promise<DraftApplyChangesResponse>((resolve) => (answerChange = resolve)),
    ),
    changeConfirmed: vi.fn(),
    batchStarted: vi.fn(),
    batchSettled: vi.fn(),
    draftDiscardStarted: vi.fn(),
    draftApplied: vi.fn(),
    draftDiscarded: vi.fn(),
  } satisfies DraftReviewCommandPorts;
  return {
    ports,
    editor: new DraftReviewSession(() => ports),
    chat: new DraftReviewSession(() => ports),
    answerChange: (response = applied) => answerChange(response),
    answerApply: (result: "applied" | "unknown") => answerApply(result),
    rejectApply: (error: Error) => rejectApply(error),
  };
}

describe("one command per draft, whichever session sends it", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("refuses a whole-draft Discard from the Chat while the Editor's per-change Apply is in flight", async () => {
    const { editor, chat, ports, answerChange } = twoSessions();
    const pending = editor.applySelection(selection, change, tokens);

    expect(await chat.discardDraft(selection)).toEqual({ kind: "blocked" });
    expect(await chat.applyReviewedDraft(selection)).toEqual({ kind: "blocked" });
    expect(await chat.disposeDrafts("discard", [selection])).toEqual([{ kind: "blocked" }]);
    expect(ports.discard).not.toHaveBeenCalled();
    expect(ports.discardChanges).not.toHaveBeenCalled();
    expect(ports.apply).not.toHaveBeenCalled();
    expect(ports.draftDiscardStarted).not.toHaveBeenCalled();

    answerChange();
    expect(await pending).toEqual({ kind: "change-settled", mode: "apply" });
    expect(ports.applyChanges).toHaveBeenCalledTimes(1);
  });

  it("refuses a per-change Apply from the Editor while the Chat's whole-draft Apply is in flight", async () => {
    const { editor, chat, ports, answerApply } = twoSessions();
    const pending = chat.applyReviewedDraft(selection);

    expect(await editor.applySelection(selection, change, tokens)).toEqual({ kind: "blocked" });
    expect(await editor.discardSelection(selection, otherChange, tokens)).toEqual({
      kind: "blocked",
    });
    expect(ports.applyChanges).not.toHaveBeenCalled();
    expect(ports.discard).not.toHaveBeenCalled();

    answerApply("applied");
    expect(await pending).toEqual({ kind: "applied" });
  });

  it("holds the change's operation set on the draft's own record, and gives it back when done", async () => {
    const { editor, answerChange } = twoSessions();
    const pending = editor.applySelection(selection, change, tokens);
    const held = currentChangeCommandRecords();
    expect(changeCommandState(held, draft, change)).toEqual({ phase: "pending", mode: "apply" });
    expect(Object.values(held.drafts)).toEqual([
      { phase: "pending", change: { ...change, mode: "apply" } },
    ]);
    answerChange();
    await pending;
    expect(currentDraftCommandRecords()).toEqual({});
  });

  it("leaves other drafts alone: only the draft with the command in flight is claimed", async () => {
    const { editor, chat, answerChange } = twoSessions();
    const pending = editor.applySelection(selection, change, tokens);
    const other = { documentId: "doc-b", draftId: "draft-b" };
    // Another session's whole-draft command on a different draft is the Work-wide
    // lock's business (the controller disables every control), not the record's.
    expect(await chat.discardDraft(other)).toEqual({ kind: "discarded" });
    answerChange();
    await pending;
  });
});

describe("a rejected whole-draft Apply", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("is held on the draft's record, so it survives the review moving on", async () => {
    const { chat, answerApply: _answer, rejectApply } = twoSessions();
    const pending = chat.applyReviewedDraft(selection);
    rejectApply(new Error("409"));
    expect(await pending).toEqual({ kind: "failed", failure: { code: "apply-offline" } });
    expect(draftCommandFailure(currentDraftCommandRecords(), draft)).toEqual({
      code: "apply-offline",
    });
  });
});

describe("a session whose ports cannot be resolved", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("gives its disposition reservation back, for a command and for a batch", async () => {
    const session = new DraftReviewSession(() => {
      throw new Error("Draft review command ports are not ready.");
    });

    await expect(session.applySelection(selection, change, tokens)).rejects.toThrow("not ready");
    expect(session.disposition.getSnapshot()).toEqual({ busy: false });
    await expect(session.disposeDrafts("discard", [selection])).rejects.toThrow("not ready");
    expect(session.disposition.getSnapshot()).toEqual({ busy: false });
  });
});
