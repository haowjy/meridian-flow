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
