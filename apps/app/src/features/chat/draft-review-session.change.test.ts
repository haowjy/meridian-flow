/**
 * Per-change commands: Apply and Discard of one change (a server closure
 * class). The change leaves at once, refusals bring it back with their reason,
 * one change in flight disables every command, and each is sent once.
 */
import type { DraftApplyChangesResponse, DraftDiscardResponse } from "@meridian/contracts/drafts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  changeCommandState,
  currentChangeCommandRecords,
  hiddenOperationIds,
  resetChangeCommandRecords,
} from "@/client/query/change-command-record";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { type DraftReviewCommandPorts, DraftReviewSession } from "./draft-review-session";

const scope = { projectId: "p", workId: "w" };
const selection = { documentId: "doc", draftId: "draft" };
const draft = { ...scope, ...selection };
const change = { classId: "closure:1+2", operationIds: ["1", "2"] };
const tokens = { liveRevisionToken: "live-1", draftRevisionToken: "draft-1" };

type Answer = DraftApplyChangesResponse | "unknown" | Error;

function harness(answer: Answer | (() => Promise<DraftApplyChangesResponse>)) {
  const applyChanges = vi.fn(async () => {
    if (typeof answer === "function") return answer();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const ports = {
    scope,
    apply: vi.fn(),
    discard: vi.fn(async () => {}),
    discardChanges: vi.fn(
      async (): Promise<DraftDiscardResponse | "unknown"> => ({
        status: "discarded",
        draftId: "draft",
      }),
    ),
    applyChanges,
    changeConfirmed: vi.fn(),
    batchStarted: vi.fn(),
    batchSettled: vi.fn(),
    draftDiscardStarted: vi.fn(),
    draftApplied: vi.fn(),
    draftDiscarded: vi.fn(),
  } satisfies DraftReviewCommandPorts;
  return { ports, session: new DraftReviewSession(() => ports) };
}

const records = async () => currentChangeCommandRecords();

describe("applying one change", () => {
  beforeEach(() => {
    resetChangeCommandRecords();
    resetDraftCommandRecords();
  });

  it("sends every operation of the change with the tokens the writer saw, then confirms it", async () => {
    const { session, ports } = harness({
      status: "applied",
      draftId: "draft",
      operationIds: ["1", "2"],
      closureClassIds: ["closure:1+2"],
    });
    const outcome = await session.applyChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-settled", mode: "apply" });
    expect(ports.applyChanges).toHaveBeenCalledWith(selection, {
      operationIds: ["1", "2"],
      ...tokens,
    });
    expect(ports.changeConfirmed).toHaveBeenCalledWith(selection, change, "apply");
  });

  it("takes the change out of view while the request is in flight", async () => {
    let answer!: (response: DraftApplyChangesResponse) => void;
    const { session } = harness(
      () => new Promise<DraftApplyChangesResponse>((resolve) => (answer = resolve)),
    );
    const pending = session.applyChange(selection, change, tokens);
    const held = await records();
    expect([...hiddenOperationIds(held, draft)]).toEqual(["1", "2"]);
    expect(changeCommandState(held, draft, change)).toEqual({ phase: "pending", mode: "apply" });
    answer({
      status: "applied",
      draftId: "draft",
      operationIds: ["1", "2"],
      closureClassIds: ["c"],
    });
    await pending;
  });

  it("sends once: a second Apply, or any other command, is blocked while one is in flight", async () => {
    let answer!: (response: DraftApplyChangesResponse) => void;
    const { session, ports } = harness(
      () => new Promise<DraftApplyChangesResponse>((resolve) => (answer = resolve)),
    );
    const first = session.applyChange(selection, change, tokens);
    expect(await session.applyChange(selection, change, tokens)).toEqual({ kind: "blocked" });
    expect(
      await session.discardChange(selection, { classId: "other", operationIds: ["9"] }, tokens),
    ).toEqual({ kind: "blocked" });
    expect(await session.applyReviewedDraft(selection)).toEqual({ kind: "blocked" });
    expect(ports.applyChanges).toHaveBeenCalledTimes(1);
    answer({
      status: "applied",
      draftId: "draft",
      operationIds: ["1", "2"],
      closureClassIds: ["c"],
    });
    await first;
    // Released: the next change can go.
    expect(
      (await session.discardChange(selection, { classId: "o", operationIds: ["9"] }, tokens)).kind,
    ).toBe("change-settled");
  });

  it.each([
    ["stale", "stale"],
    ["incomplete_class", "stale"],
    ["draft_only", "draft-only"],
  ] as const)("a %s refusal brings the change back with its reason", async (status, code) => {
    const { session, ports } = harness({ status, draftId: "draft" });
    const outcome = await session.applyChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "apply", code });
    expect(ports.changeConfirmed).not.toHaveBeenCalled();
    const held = await records();
    expect(hiddenOperationIds(held, draft).size).toBe(0);
    expect(changeCommandState(held, draft, change)).toEqual({
      phase: "failed",
      mode: "apply",
      code,
    });
  });

  it("a change the server no longer has leaves, and says so", async () => {
    const { session, ports } = harness({ status: "gone", draftId: "draft" });
    const outcome = await session.applyChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "apply", code: "gone" });
    expect(ports.changeConfirmed).toHaveBeenCalledWith(selection, change, "apply");
  });

  it("a request that got no answer is held on the change as unknown, never as a refusal", async () => {
    const { session, ports } = harness("unknown");
    const outcome = await session.applyChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "apply", code: "unknown" });
    expect(ports.changeConfirmed).not.toHaveBeenCalled();
    expect(changeCommandState(await records(), draft, change)).toEqual({
      phase: "failed",
      mode: "apply",
      code: "unknown",
    });
  });

  it("a request the server refused brings the change back as an offline failure", async () => {
    const { session, ports } = harness(new Error("refused"));
    const outcome = await session.applyChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "apply", code: "offline" });
    expect(ports.changeConfirmed).not.toHaveBeenCalled();
    expect(changeCommandState(await records(), draft, change)).toEqual({
      phase: "failed",
      mode: "apply",
      code: "offline",
    });
  });

  it("the failure follows the change when the server regroups it", async () => {
    const { session } = harness({ status: "stale", draftId: "draft" });
    await session.applyChange(selection, change, tokens);
    // After the refetch the class has a new id but shares an operation.
    const regrouped = { classId: "closure:2+3", operationIds: ["2", "3"] };
    expect(changeCommandState(await records(), draft, regrouped)).toMatchObject({
      phase: "failed",
      code: "stale",
    });
    expect(
      changeCommandState(await records(), draft, { classId: "x", operationIds: ["7"] }),
    ).toBeNull();
  });
});

describe("discarding one change", () => {
  beforeEach(() => {
    resetChangeCommandRecords();
    resetDraftCommandRecords();
  });

  it("sends every operation of the change, including the writer's edits inside it, with the tokens the writer saw", async () => {
    const { session, ports } = harness("unknown");
    const outcome = await session.discardChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-settled", mode: "discard" });
    expect(ports.discardChanges).toHaveBeenCalledWith(selection, {
      operationIds: ["1", "2"],
      ...tokens,
    });
    expect(ports.discard).not.toHaveBeenCalled();
    expect(ports.changeConfirmed).toHaveBeenCalledWith(selection, change, "discard");
  });

  it.each([
    ["stale", "stale"],
    ["incomplete_class", "stale"],
    ["draft_only", "draft-only"],
  ] as const)("a %s refusal brings the change back with its reason, never as a discard", async (status, code) => {
    const { session, ports } = harness("unknown");
    ports.discardChanges.mockResolvedValueOnce({ status, draftId: "draft", draftClosed: true });
    const outcome = await session.discardChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "discard", code });
    expect(ports.changeConfirmed).not.toHaveBeenCalled();
    const held = await records();
    expect(hiddenOperationIds(held, draft).size).toBe(0);
    expect(changeCommandState(held, draft, change)).toEqual({
      phase: "failed",
      mode: "discard",
      code,
    });
  });

  it("a change the server no longer has leaves, and says so", async () => {
    const { session, ports } = harness("unknown");
    ports.discardChanges.mockResolvedValueOnce({ status: "gone", draftId: "draft" });
    expect(await session.discardChange(selection, change, tokens)).toEqual({
      kind: "change-refused",
      mode: "discard",
      code: "gone",
    });
    expect(ports.changeConfirmed).toHaveBeenCalledWith(selection, change, "discard");
  });

  it("a Discard that got no answer is held on the change as unknown, as an Apply's is", async () => {
    const { session, ports } = harness("unknown");
    ports.discardChanges.mockResolvedValueOnce("unknown");
    const outcome = await session.discardChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "discard", code: "unknown" });
    expect(ports.changeConfirmed).not.toHaveBeenCalled();
    expect(changeCommandState(await records(), draft, change)).toEqual({
      phase: "failed",
      mode: "discard",
      code: "unknown",
    });
  });

  it("a Discard the server refused brings the change back as an offline failure", async () => {
    const { session, ports } = harness("unknown");
    ports.discardChanges.mockRejectedValueOnce(new Error("refused"));
    const outcome = await session.discardChange(selection, change, tokens);
    expect(outcome).toEqual({ kind: "change-refused", mode: "discard", code: "offline" });
    expect(changeCommandState(await records(), draft, change)).toEqual({
      phase: "failed",
      mode: "discard",
      code: "offline",
    });
  });
});
