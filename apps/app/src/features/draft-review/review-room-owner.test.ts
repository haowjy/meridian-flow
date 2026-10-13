/** The room owner's addressed observation protocol, using the production reducer. */
import { describe, expect, it } from "vitest";
import {
  beginDraftCommand,
  confirmDraftCommand,
  currentChangeCommandRecords,
  readDraftsAfterCommands,
  readPreviewAfterChangeCommands,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { draftA, listed, previewOf } from "@/test-support/draft-review-scope";
import {
  type DraftReviewAction,
  type DraftReviewState,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
} from "./draft-review-session";
import { reviewRoomObservations } from "./useReviewRoomOwner";

const enter = (generation = 1): DraftReviewAction => ({
  type: "enterInline",
  ...draftA,
  branchGeneration: generation,
});
const closed: DraftReviewAction = {
  type: "completionObserved",
  ...draftA,
  branchGeneration: 1,
  completion: { phase: "closed", documentName: "Chapter 12" },
};
const pending: DraftReviewAction = {
  type: "completionObserved",
  ...draftA,
  branchGeneration: 1,
  completion: { phase: "pending", mode: "apply", documentName: "Chapter 12" },
};
const observe = (generation: number, proposal = true, roomName?: string): DraftReviewAction => ({
  type: "generationObserved",
  ...draftA,
  branchGeneration: generation,
  proposal,
  roomName,
});
const proposal = (generation: number, ...ids: string[]) => ({
  ...previewOf(...ids),
  branchGeneration: generation,
  reviewRoomName: `room-g${generation}`,
});
const missing = (generation: number, ...ids: string[]) =>
  reviewRoomObservations([], proposal(generation, ...ids), draftA);
const shown = (state: DraftReviewState) =>
  state.surface.kind === "inline"
    ? {
        itemKey: state.surface.itemKey,
        generation: state.surface.branchGeneration,
        completion: state.surface.completion?.phase ?? null,
        room: state.surface.roomName ?? null,
      }
    : null;

describe("review-room transition table", () => {
  it.each<{ name: string; actions: DraftReviewAction[]; result: ReturnType<typeof shown> }>([
    {
      name: "new proposal interrupts pending",
      actions: [enter(), pending, observe(2, true, "room-g2"), closed],
      result: { itemKey: "draft-a", generation: 2, completion: null, room: "room-g2" },
    },
    {
      name: "new proposal re-enters closed even after an older room answer",
      actions: [enter(), closed, observe(2, true, "room-g2"), observe(1, true, "old")],
      result: { itemKey: "draft-a", generation: 2, completion: null, room: "room-g2" },
    },
    {
      name: "empty reset does not certify pending",
      actions: [enter(), pending, ...missing(2)],
      result: { itemKey: "draft-a", generation: 1, completion: "pending", room: null },
    },
    {
      name: "same generation never reopens closed",
      actions: [enter(), closed, observe(1)],
      result: { itemKey: "draft-a", generation: 1, completion: "closed", room: null },
    },
    {
      name: "a newer preview survives a lagging empty list",
      actions: [enter(), ...missing(2, "3"), observe(1)],
      result: { itemKey: "draft-a", generation: 2, completion: null, room: null },
    },
    {
      name: "a lagging listed generation cannot replace the preview",
      actions: [
        enter(),
        ...reviewRoomObservations([{ ...listed, branchGeneration: 1 }], proposal(2, "3"), draftA),
      ],
      result: { itemKey: "draft-a", generation: 2, completion: null, room: null },
    },
    ...[1, 2].map((readGeneration) => ({
      name:
        readGeneration === 1
          ? "cached G1 gone cannot cancel the adopted G2 row"
          : "fresh G2 gone closes despite a stale G2 row",
      actions: [
        enter(),
        closed,
        ...reviewRoomObservations(
          [{ ...listed, branchGeneration: 2 }],
          { status: "gone" as const, itemKey: draftA.itemKey, branchGeneration: readGeneration },
          draftA,
        ),
        // The next layout pass sees completion cleared by the G2 observation.
        ...reviewRoomObservations(
          [{ ...listed, branchGeneration: 2 }],
          { status: "gone" as const, itemKey: draftA.itemKey, branchGeneration: readGeneration },
          draftA,
        ),
      ],
      result:
        readGeneration === 1
          ? { itemKey: "draft-a", generation: 2, completion: null, room: null }
          : null,
    })),
    { name: "genuine external absence exits", actions: [enter(), ...missing(2)], result: null },
    {
      name: "confirmed close is held through absence",
      actions: [enter(), closed, ...missing(2)],
      result: { itemKey: "draft-a", generation: 1, completion: "closed", room: null },
    },
    {
      name: "refusal withdraws only predicted completion",
      actions: [
        enter(),
        pending,
        { type: "completionObserved", ...draftA, branchGeneration: 1, completion: null },
      ],
      result: { itemKey: "draft-a", generation: 1, completion: null, room: null },
    },
    {
      name: "a next-generation claim is adopted, not the old one",
      actions: [enter(), pending, { ...closed, branchGeneration: 2 }, pending],
      result: { itemKey: "draft-a", generation: 2, completion: "closed", room: null },
    },
    {
      name: "departed draft answers cannot replace a new review",
      actions: [
        enter(),
        { type: "enterInline", documentId: "document-b", itemKey: "draft-b", branchGeneration: 4 },
        observe(9, true, "old"),
        closed,
      ],
      result: { itemKey: "draft-b", generation: 4, completion: null, room: null },
    },
    {
      name: "retired room signals cannot clear its successor",
      actions: [
        enter(),
        observe(2, true, "room-g2"),
        { type: "roomStale", ...draftA, roomName: "room-g1" },
      ],
      result: { itemKey: "draft-a", generation: 2, completion: null, room: "room-g2" },
    },
  ])("$name", ({ actions, result }) => {
    const [entry, ...observations] = actions;
    const state = [
      entry,
      { type: "marksVisible", visible: false } as DraftReviewAction,
      {
        type: "changeFocused",
        ...draftA,
        focus: { classId: "class-1", operationIds: ["1"] },
      } as DraftReviewAction,
      ...observations,
    ].reduce(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
    expect(shown(state)).toEqual(result);
    if (result?.generation === 2 && result.completion === null) {
      expect(state.marksVisible).toBe(true);
      // The focused change survives a generation change; surfaces find it again by its operations.
      if (state.surface.kind === "inline")
        expect(state.surface.focus).toEqual({ classId: "class-1", operationIds: ["1"] });
    }
  });
});

it("retains an applied row's generation evidence without presenting it as a proposal", async () => {
  resetDraftCommandRecords();
  const scope = { projectId: "project-a", workId: "work-a" };
  const draft = { ...scope, ...draftA };
  const claim = beginDraftCommand(draft, { target: "all", mode: "apply", branchGeneration: 5 });
  if (!claim) throw new Error("claim refused");
  confirmDraftCommand(claim);
  const observe = (generation: number) =>
    reviewRoomObservations(
      [{ ...listed, branchGeneration: generation }],
      proposal(generation, "1"),
      draftA,
      null,
      false,
      { scope, records: currentChangeCommandRecords() },
    );
  expect(observe(5)).toEqual([
    { type: "generationObserved", ...draftA, branchGeneration: 5, proposal: false },
    { type: "generationObserved", ...draftA, branchGeneration: 5, proposal: false },
  ]);
  expect(observe(6)).toEqual([
    { type: "generationObserved", ...draftA, branchGeneration: 6, proposal: true },
    { type: "generationObserved", ...draftA, branchGeneration: 6, proposal: true },
  ]);
  const freshRows = await readDraftsAfterCommands(scope, async () => [
    { ...listed, branchGeneration: 5 },
  ]);
  const freshPreview = await readPreviewAfterChangeCommands(draft, async () => proposal(5, "2"));
  expect(
    reviewRoomObservations(freshRows, freshPreview, draftA, null, false, {
      scope,
      records: currentChangeCommandRecords(),
    }),
  ).toEqual([
    { type: "generationObserved", ...draftA, branchGeneration: 5, proposal: true },
    { type: "generationObserved", ...draftA, branchGeneration: 5, proposal: true },
  ]);
  expect(
    observe(5).every((action) => action.type === "generationObserved" && !action.proposal),
  ).toBe(true);
  resetDraftCommandRecords();
});
