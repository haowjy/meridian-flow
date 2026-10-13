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

it("keys a local turn by its id but names no server identity, and places a stand-in after its source", () => {
  const local = `${OPTIMISTIC_TURN_ID_PREFIX}1`;
  const view = viewTranscript({
    turns: [turn("u1", "user", null), turn("a1", "assistant", "u1"), turn(local, "user", "a1")],
    activity: { awaitingSubagents: false },
    standIns: [turn("a2", "assistant", "a1", { status: "pending", blocks: [] })],
    queued: new Set([local]),
  });
  expect(view.rows.map((row) => row.renderKey)).toEqual(["u1", "a1", "a2", local]);
  expect(view.rows.map((row) => row.identity.turnId)).toEqual(["u1", "a1", "a2", null]);
  expect(view.rows.map((row) => row.queued)).toEqual([false, false, false, true]);
  expect([...view.writer.keys()]).toEqual(["u1", local]);
  expect(view.items.get("a1")?.items.map((item) => item.kind)).toEqual(["text"]);
});
