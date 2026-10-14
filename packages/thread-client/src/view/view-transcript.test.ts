/** Guards the view model's seams: row identity versus render key, stand-in placement, queued writer rows, and which turns draw as items. */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { OPTIMISTIC_TURN_ID_PREFIX } from "./optimistic-turn-id";
import { viewTranscript } from "./view-transcript";

function turn(
  id: string,
  role: Turn["role"],
  prev: string | null,
  extra: Partial<Turn> = {},
): Turn {
  const text: Block = {
    id: `${id}-text`,
    turnId: id,
    responseId: null,
    blockType: "text",
    sequence: 0,
    content: {},
    status: "complete",
    textContent: `${id} words`,
    createdAt: "2026-10-13T00:00:00.000Z",
  };
  return {
    id,
    threadId: "t",
    role,
    status: "complete",
    prevTurnId: prev,
    blocks: [text],
    responses: [],
    metadata: null,
    ...extra,
  } as unknown as Turn;
}

it("keys every row but names a server identity only for turns the server stated, and gives every reply-shaped row a response", () => {
  const local = `${OPTIMISTIC_TURN_ID_PREFIX}1`;
  const card = turn("c1", "system", "a1", {
    blocks: [{ ...turn("c1", "system", null).blocks[0], blockType: "custom" } as Block],
  });
  const view = viewTranscript({
    opening: turn("optimistic-seed:t", "system", null, {
      blocks: [],
      metadata: {
        kind: "derivation_seed",
        derivation: "handoff",
        sourceThreadId: "s",
        cutoffTurnId: "x",
      },
    }),
    turns: [
      turn("u1", "user", null),
      turn("a1", "assistant", "u1"),
      card,
      turn(local, "user", "c1"),
    ],
    activity: { awaitingSubagents: false },
    standIns: [turn("a2", "assistant", "c1", { status: "pending", blocks: [] })],
    queued: new Set([local]),
  });
  expect(view.rows.map((row) => row.renderKey)).toEqual([
    "optimistic-seed:t",
    "u1",
    "a1",
    "c1",
    "a2",
    local,
  ]);
  // The opening seed, a Retry stand-in and a local writer turn have no server identity.
  expect(view.rows.map((row) => row.identity.turnId)).toEqual([null, "u1", "a1", "c1", null, null]);
  expect(view.rows.map((row) => row.queued)).toEqual([false, false, false, false, false, true]);
  expect([...view.writer.keys()]).toEqual(["u1", local]);
  expect(view.items.get("a1")?.items.map((item) => item.kind)).toEqual(["text"]);
  // A system card is its own single response part, so it keeps the settled action row.
  expect(view.rows[3]?.response?.parts.map((part) => part.id)).toEqual(["c1"]);
});

const ids = (view: ReturnType<typeof viewTranscript>) => view.rows.map((row) => row.turn.id);

it("draws a pending Retry in the failed reply's place, even with a message sent after it", () => {
  // Risk: the stand-in drifting below a later message, or the failed reply drawn beside its Retry.
  const failed = turn("f", "assistant", "u1", { status: "error" });
  const base = [turn("u1", "user", null), failed, turn("u2", "user", "f")];
  const standIn = turn("r1", "assistant", "f", {
    status: "pending",
    blocks: [],
    metadata: { retryOf: "f" },
  });
  const pending = viewTranscript({
    turns: base,
    standIns: [standIn],
    activity: { awaitingSubagents: false },
  });
  expect(ids(pending)).toEqual(["u1", "r1", "u2"]);
  // Risk: a pending switch's notice at the tail while its turn lands before the Retry's reply,
  // so it jumps when the frame arrives. `awaiting_run` sits before the stand-in from the press
  // until the stored turn replaces it; `waiting` (a reply holds the chat) stays at the tail.
  const slot = (switchAwaitsRun: boolean) =>
    viewTranscript({
      turns: base,
      standIns: [standIn],
      switchAwaitsRun,
      activity: { awaitingSubagents: false },
    }).controlSlot;
  expect([slot(true), slot(false)]).toEqual([1, 3]);
  // Risk (review S1): a lost Retry R1 of an earlier failure survives while newer replies pile
  // up; the switch's notice must follow the Retry R2 of the current leaf, not jump above R1.
  const lost = turn("r0", "assistant", "f", {
    status: "pending",
    blocks: [],
    metadata: { retryOf: "f" },
  });
  const later = [...base, turn("f2", "assistant", "u2", { status: "error" })];
  const slotAmong = (standIns: Turn[]) =>
    viewTranscript({
      turns: later,
      standIns,
      switchAwaitsRun: true,
      activity: { awaitingSubagents: false },
    }).controlSlot;
  const next = turn("r2", "assistant", "f2", {
    status: "pending",
    blocks: [],
    metadata: { retryOf: "f2" },
  });
  // Only the old one survives: no stand-in qualifies, the notice is at the tail (after u1, r0, u2, f2).
  expect(slotAmong([lost])).toBe(4);
  // With the current leaf's Retry (rows u1, r0, u2, r2) the notice sits at it, below the old one.
  expect(slotAmong([lost, next])).toBe(3);
  // Refused: the stand-in goes, and nothing supersedes the failed reply.
  expect(ids(viewTranscript({ turns: base, activity: { awaitingSubagents: false } }))).toEqual([
    "u1",
    "f",
    "u2",
  ]);
  // Accepted, and the store has no turn that names it yet: the explicit target holds F out.
  expect(
    ids(
      viewTranscript({
        turns: [...base, turn("r1", "assistant", "u2", { status: "streaming" })],
        retried: new Set(["f"]),
        activity: { awaitingSubagents: false },
      }),
    ),
  ).toEqual(["u1", "u2", "r1"]);
});

it("draws one failure for a chain of failed retries, the newest", () => {
  // Risk: every failed attempt stacking up as "This response failed." lines.
  const view = viewTranscript({
    turns: [
      turn("u1", "user", null),
      turn("f", "assistant", "u1", { status: "error" }),
      // The Retry's first reserved turn can be a compaction, not the reply: it carries retryOf.
      turn("c1", "compaction", "f", { metadata: { retryOf: "f" } }),
      turn("r1", "assistant", "c1", { status: "error" }),
      turn("r2", "assistant", "r1", { status: "error", metadata: { retryOf: "r1" } }),
    ],
    activity: { awaitingSubagents: false },
  });
  expect(view.rows.filter((row) => row.turn.status === "error").map((row) => row.turn.id)).toEqual([
    "r2",
  ]);
  expect(ids(view)).toEqual(["u1", "c1", "r2"]);
});

it("leaves a handed-back message out and keeps history and later sends", () => {
  // Risk: a hand-back hiding delivered history or a message sent after the press.
  const view = viewTranscript({
    turns: [
      turn("m1", "user", null),
      turn("a1", "assistant", "m1"),
      turn("m2", "user", "a1"),
      turn("m3", "user", "m2"),
    ],
    hidden: new Set(["m2"]),
    activity: { awaitingSubagents: false },
  });
  expect(ids(view)).toEqual(["m1", "a1", "m3"]);
});
