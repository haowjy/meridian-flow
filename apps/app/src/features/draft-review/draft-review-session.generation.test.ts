/**
 * The rule table for an open review against its draft's generation, one case
 * per row. The server resets a closed draft one generation up and reuses its id
 * for the next proposal, so the reducer compares the generation of every input
 * (a claim's, a read's) with the one the review shows (R) and nothing else.
 */
import { describe, expect, it } from "vitest";
import {
  type DraftReviewAction,
  type DraftReviewState,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  inlineReviewFromState,
  type ReviewClaim,
} from "./draft-review-session";

const A = { documentId: "doc", draftId: "draft" };
const pending = { phase: "pending", mode: "apply", documentName: "Chapter" } as const;
const closed = { phase: "closed", documentName: "Chapter" } as const;

function run(state: DraftReviewState, ...actions: DraftReviewAction[]): DraftReviewState {
  return actions.reduce(draftReviewReducer, state);
}

const enter = (known?: number, claim?: ReviewClaim): DraftReviewAction => ({
  type: "enterInline",
  ...A,
  ...(known !== undefined ? { draftGeneration: known } : {}),
  ...(claim ? { claim } : {}),
});

/** A review of generation `generation` with its room resolved and the given completion. */
function reviewing(
  generation: number,
  completion?: typeof pending | typeof closed,
): DraftReviewState {
  return run(
    EMPTY_DRAFT_REVIEW_STATE,
    enter(generation, completion ? { draftGeneration: generation, completion } : undefined),
    {
      type: "generationObserved",
      ...A,
      draftGeneration: generation,
      proposal: true,
      roomName: `room-${generation}`,
    },
  );
}

const observed = (
  draftGeneration: number,
  proposal: boolean,
  extra: Partial<Extract<DraftReviewAction, { type: "generationObserved" }>> = {},
): DraftReviewAction => ({ type: "generationObserved", ...A, draftGeneration, proposal, ...extra });

const completing = (draftGeneration: number): DraftReviewAction => ({
  type: "reviewCompleting",
  ...A,
  draftGeneration,
  mode: "apply",
  documentName: "Chapter",
});
const answeredClosed = (draftGeneration: number): DraftReviewAction => ({
  type: "reviewClosed",
  ...A,
  draftGeneration,
  documentName: "Chapter",
});
const claimEnded = (draftGeneration: number): DraftReviewAction => ({
  type: "reviewReopened",
  ...A,
  draftGeneration,
});

const review = (state: DraftReviewState) => inlineReviewFromState(state);

describe("E: the writer enters a draft", () => {
  it("shows the newest proposal known: the cache's and a claim's, whichever is higher", () => {
    expect(review(run(EMPTY_DRAFT_REVIEW_STATE, enter(2)))?.draftGeneration).toBe(2);
    expect(
      review(run(EMPTY_DRAFT_REVIEW_STATE, enter(2, { draftGeneration: 3 })))?.draftGeneration,
    ).toBe(3);
  });

  it("is unresolved when nothing is known", () => {
    expect(review(run(EMPTY_DRAFT_REVIEW_STATE, enter()))?.draftGeneration).toBeUndefined();
  });

  it("takes the claim's completion only when the claim acted on the shown generation", () => {
    expect(
      review(run(EMPTY_DRAFT_REVIEW_STATE, enter(2, { draftGeneration: 2, completion: pending })))
        ?.completion,
    ).toEqual(pending);
    // The claim is of an earlier proposal than the one the caches know of.
    expect(
      review(run(EMPTY_DRAFT_REVIEW_STATE, enter(3, { draftGeneration: 2, completion: closed })))
        ?.completion,
    ).toBeUndefined();
  });

  it("keeps an open review of the draft as it is, apart from retrying a failed room read", () => {
    const open = reviewing(2, pending);
    expect(run(open, enter(5))).toBe(open);
    const failed = run(
      open,
      { type: "roomStale", ...A, roomName: "room-2" },
      { type: "roomFailed", ...A },
    );
    expect(review(failed)?.roomError).toBe(true);
    expect(review(run(failed, enter()))?.roomError).toBeUndefined();
  });
});

describe("C1: a claim begins, covering the last changes (C = R)", () => {
  it("makes the completion pending", () => {
    expect(review(run(reviewing(2), completing(2)))?.completion).toEqual(pending);
  });

  it("leaves a closed completion closed", () => {
    expect(review(run(reviewing(2, closed), completing(2)))?.completion).toEqual(closed);
  });
});

describe("C2: the claim is answered draftClosed (C = R)", () => {
  it("makes the completion closed, from pending or from none", () => {
    expect(review(run(reviewing(2, pending), answeredClosed(2)))?.completion).toEqual(closed);
    expect(review(run(reviewing(2), answeredClosed(2)))?.completion).toEqual(closed);
  });
});

describe("C3: the claim ends without a close (C = R)", () => {
  it("withdraws a pending completion", () => {
    expect(review(run(reviewing(2, pending), claimEnded(2)))?.completion).toBeUndefined();
  });

  it("keeps a closed completion", () => {
    expect(review(run(reviewing(2, closed), claimEnded(2)))?.completion).toEqual(closed);
  });
});

describe("C4: a claim of an earlier proposal (C < R)", () => {
  it.each([
    ["begins", completing(1)],
    ["is answered closed", answeredClosed(1)],
    ["ends", claimEnded(1)],
  ])("is ignored when it %s", (_what, action) => {
    const open = reviewing(2, pending);
    expect(run(open, action)).toBe(open);
  });
});

describe("C5: a claim of a later proposal, or the review has none yet (C > R)", () => {
  it("re-enters the claim's generation with the claim's completion", () => {
    const entered = review(run(reviewing(1), completing(2)));
    expect(entered).toMatchObject({ draftGeneration: 2, completion: pending });
    expect(entered?.roomName).toBeUndefined();
    expect(review(run(reviewing(1, closed), answeredClosed(2)))).toMatchObject({
      draftGeneration: 2,
      completion: closed,
    });
  });

  it("takes the generation of the first claim when the review had none", () => {
    expect(review(run(run(EMPTY_DRAFT_REVIEW_STATE, enter()), completing(4)))).toMatchObject({
      draftGeneration: 4,
      completion: pending,
    });
  });
});

describe("O1: a read of an earlier generation (N < R)", () => {
  it("is ignored, whatever the review holds", () => {
    const open = reviewing(3, closed);
    expect(run(open, observed(2, true))).toBe(open);
    expect(run(open, observed(2, true, { roomName: "room-2" }))).toBe(open);
  });
});

describe("O2: a read of the shown generation (N = R)", () => {
  it("changes nothing, and a closed generation never reopens", () => {
    const open = reviewing(2, closed);
    expect(run(open, observed(2, true))).toBe(open);
    expect(review(run(open, observed(2, true)))?.completion).toEqual(closed);
  });
});

describe("O3: a read of a later generation that lists changes (N > R)", () => {
  it.each([
    ["no completion", undefined],
    ["a pending completion", pending],
    ["a closed completion", closed],
  ] as const)("re-enters it in place over %s", (_what, completion) => {
    const marks = run(reviewing(2, completion), { type: "marksVisible", visible: false });
    const focused = run(marks, {
      type: "changeFocused",
      ...A,
      focus: { classId: "class-1", operationIds: ["1"] },
    });
    const next = run(focused, observed(3, true));
    expect(review(next)).toMatchObject({ draftGeneration: 3 });
    // The old generation's completion, focus and room are left behind, the marks come back.
    expect(review(next)?.completion).toBeUndefined();
    expect(review(next)?.focus).toBeUndefined();
    expect(review(next)?.roomName).toBeUndefined();
    expect(next.marksVisible).toBe(true);
  });

  it("adopts the claim's completion when it acted on the new generation", () => {
    const next = run(
      reviewing(2, closed),
      observed(3, true, { claim: { draftGeneration: 3, completion: pending } }),
    );
    expect(review(next)?.completion).toEqual(pending);
  });

  it("does not adopt a claim of the old generation", () => {
    const next = run(
      reviewing(2),
      observed(3, true, { claim: { draftGeneration: 2, completion: pending } }),
    );
    expect(review(next)?.completion).toBeUndefined();
  });
});

describe("O4: a read of a later generation that lists no change (the close's reset)", () => {
  it("changes nothing: a pending completion waits for its answer, a closed one stays", () => {
    const waiting = reviewing(2, pending);
    expect(run(waiting, observed(3, false))).toBe(waiting);
    const done = reviewing(2, closed);
    expect(run(done, observed(3, false))).toBe(done);
  });

  it("lets the answer close the generation the command acted on, after the reset was seen", () => {
    const next = run(reviewing(2, pending), observed(3, false), answeredClosed(2));
    expect(review(next)).toMatchObject({ draftGeneration: 2, completion: closed });
  });

  it("then takes up the next proposal, which shares the reset's generation", () => {
    const next = run(
      reviewing(2, pending),
      observed(3, false),
      answeredClosed(2),
      observed(3, true),
    );
    expect(review(next)).toMatchObject({ draftGeneration: 3 });
    expect(review(next)?.completion).toBeUndefined();
  });
});

describe("P: the room read resolves", () => {
  it("gives an unresolved review the generation and the room of the read", () => {
    const next = run(EMPTY_DRAFT_REVIEW_STATE, enter(), observed(4, true, { roomName: "room-4" }));
    expect(review(next)).toMatchObject({ draftGeneration: 4, roomName: "room-4" });
  });

  it("sets the room of the shown generation", () => {
    const next = run(
      run(EMPTY_DRAFT_REVIEW_STATE, enter(2)),
      observed(2, true, { roomName: "room-2" }),
    );
    expect(review(next)).toMatchObject({ draftGeneration: 2, roomName: "room-2" });
  });

  it("applies O3 to a read of a later generation and takes its room", () => {
    const next = run(
      run(EMPTY_DRAFT_REVIEW_STATE, enter(2)),
      observed(3, true, { roomName: "room-3" }),
    );
    expect(review(next)).toMatchObject({ draftGeneration: 3, roomName: "room-3" });
  });

  it("applies O4 to a reset read: the shown generation stays, the room is the live one", () => {
    const next = run(reviewing(2, pending), observed(3, false, { roomName: "room-3" }));
    expect(review(next)).toMatchObject({
      draftGeneration: 2,
      completion: pending,
      roomName: "room-3",
    });
  });

  it("is ignored when it reads an earlier generation than the review shows", () => {
    const asking = run(reviewing(3), { type: "roomStale", ...A, roomName: "room-3" });
    expect(run(asking, observed(2, true, { roomName: "room-2" }))).toBe(asking);
  });

  it("records a failed read on a review still waiting for its room, and only then", () => {
    const waiting = run(EMPTY_DRAFT_REVIEW_STATE, enter(2));
    expect(review(run(waiting, { type: "roomFailed", ...A }))?.roomError).toBe(true);
    const resolved = reviewing(2);
    expect(run(resolved, { type: "roomFailed", ...A })).toBe(resolved);
  });
});

describe("S: the review's room is reported stale", () => {
  it("asks for a new room and keeps everything else", () => {
    const next = run(reviewing(2, pending), { type: "roomStale", ...A, roomName: "room-2" });
    expect(review(next)).toMatchObject({ draftGeneration: 2, completion: pending });
    expect(review(next)?.roomName).toBeUndefined();
  });

  it("ignores a room the review no longer shows", () => {
    const open = reviewing(3);
    expect(run(open, { type: "roomStale", ...A, roomName: "room-2" })).toBe(open);
  });

  it("then resolves through the read: the later generation's room under a pending completion", () => {
    const next = run(
      reviewing(2, pending),
      { type: "roomStale", ...A, roomName: "room-2" },
      observed(3, false, { roomName: "room-3" }),
      answeredClosed(2),
    );
    expect(review(next)).toMatchObject({
      draftGeneration: 2,
      completion: closed,
      roomName: "room-3",
    });
  });
});

describe("X: the Work's list has no row for the draft", () => {
  const absent = (
    evidence: { draftGeneration: number; proposal: boolean } | null,
  ): DraftReviewAction => ({ type: "draftAbsentFromList", ...A, evidence });

  it("ends a review with no completion when no preview lists changes (an external close)", () => {
    expect(review(run(reviewing(2), absent(null)))).toBeNull();
    expect(review(run(reviewing(2), absent({ draftGeneration: 2, proposal: false })))).toBeNull();
  });

  it("ends a review whose only evidence is of an earlier generation", () => {
    expect(review(run(reviewing(2), absent({ draftGeneration: 1, proposal: true })))).toBeNull();
  });

  it.each([
    2, 3,
  ])("keeps a review while the preview lists changes at R or above (%i)", (generation) => {
    const open = reviewing(2);
    expect(run(open, absent({ draftGeneration: generation, proposal: true }))).toBe(open);
  });

  it("keeps a review whose generation is unresolved while a preview lists changes", () => {
    const unresolved = run(EMPTY_DRAFT_REVIEW_STATE, enter());
    expect(run(unresolved, absent({ draftGeneration: 2, proposal: true }))).toBe(unresolved);
  });

  it("keeps a review that holds a completion, whatever the evidence", () => {
    const finished = reviewing(2, closed);
    expect(run(finished, absent(null))).toBe(finished);
    const completing = reviewing(2, pending);
    expect(run(completing, absent(null))).toBe(completing);
  });

  it("ends in the same state whichever of the list and the newer proposal arrives first", () => {
    const evidence = { draftGeneration: 3, proposal: true };
    const listFirst = run(
      reviewing(2),
      absent(evidence),
      observed(3, true, { roomName: "room-3" }),
    );
    const previewFirst = run(
      reviewing(2),
      observed(3, true, { roomName: "room-3" }),
      absent(evidence),
    );
    expect(review(listFirst)).toMatchObject({ draftGeneration: 3, roomName: "room-3" });
    expect(listFirst).toEqual(previewFirst);
  });
});

describe("L: the writer leaves, or enters another draft", () => {
  const other = { documentId: "doc-b", draftId: "draft-b" };
  const inputs = [
    observed(9, true),
    completing(9),
    answeredClosed(9),
    claimEnded(9),
    { type: "roomStale", ...A, roomName: "room-2" },
    { type: "draftAbsentFromList", ...A, evidence: null },
  ] as const;

  it.each(inputs)("leaves no review for D to take $type", (input) => {
    const left = run(reviewing(2, pending), { type: "exitInline" });
    expect(run(left, input)).toBe(left);
  });

  it.each(inputs)("leaves the review of another draft alone on $type", (input) => {
    const elsewhere = run(reviewing(2, pending), {
      type: "enterInline",
      ...other,
      draftGeneration: 1,
    });
    expect(run(elsewhere, input)).toBe(elsewhere);
  });
});

describe("B: a whole-draft batch holds the review", () => {
  it("carries the generation shown when the batch began through pending and closed", () => {
    const next = run(reviewing(2), completing(2), answeredClosed(2));
    expect(review(next)?.completion).toEqual(closed);
  });

  it("withdraws the hold when the batch ends without closing the review", () => {
    expect(review(run(reviewing(2), completing(2), claimEnded(2)))?.completion).toBeUndefined();
  });

  it("is not applied to a proposal that arrived during the batch", () => {
    const next = run(reviewing(2), completing(2), observed(3, true), answeredClosed(2));
    expect(review(next)).toMatchObject({ draftGeneration: 3 });
    expect(review(next)?.completion).toBeUndefined();
  });
});
