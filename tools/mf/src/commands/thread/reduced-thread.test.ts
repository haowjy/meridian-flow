/** The snapshot/replay boundary: freshness (`nextSeq`) and replay coverage (`resumeAfterSeq`) are separate facts. */
import type { AGUIEvent, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { EventType, WRITE_MODE_SWITCHED_EVENT } from "@meridian/contracts/protocol";
import {
  GOLDEN_ASSISTANT_TURN_ID,
  GOLDEN_THREAD_ID,
  SIMPLE_TEXT_TURN_AGUI,
} from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import { viewSnapshot } from "./chat-view";
import { ReducedThread } from "./reduced-thread";
import { replyText } from "./reply-text";

const THREAD = GOLDEN_THREAD_ID;
const event = (value: Record<string, unknown>) => value as unknown as AGUIEvent;

it("applies journal-only deltas between the replay cursor and nextSeq, and rejects only stale snapshots", () => {
  const reduced = new ReducedThread(THREAD);
  // The projection stopped at seq 97 while the journal head is 103: deltas 98..103 exist only as events.
  expect(reduced.hydrate({ turns: [], nextSeq: "104" })).toBe(true);
  // The golden stream carries a `run_state` record at each end; a
  // write-mode switch frame lands mid-reply. None of them is transcript content.
  const replay = [...SIMPLE_TEXT_TURN_AGUI];
  replay.splice(
    3,
    0,
    event({
      type: EventType.CUSTOM,
      name: WRITE_MODE_SWITCHED_EVENT,
      value: {
        threadId: THREAD,
        mode: "direct",
        controlId: "c1",
        turnId: "sys-1",
        prevTurnId: null,
        position: 0,
      },
    }),
  );
  replay.forEach((item, index) => {
    reduced.apply(item, String(98 + index));
  });
  const turnId = GOLDEN_ASSISTANT_TURN_ID;

  const stored = { turns: reduced.turns(), nextSeq: "104" } as unknown as ThreadSnapshotResponse;
  expect(reduced.turn(turnId)?.status).toBe("complete");
  expect(reduced.compare(stored, [turnId], false)).toEqual({ liveView: "matches" });
  expect(replyText(reduced.turns(), turnId)).toBe("Hello world");
  // Same shape the app's view model gives: one text block, one text item, no custom artifact.
  expect(reduced.turn(turnId)?.blocks.map((block) => [block.blockType, block.sequence])).toEqual([
    ["text", 0],
  ]);
  const view = viewSnapshot(
    {
      liveState: {
        runState: {
          version: "9999",
          items: [],
          sentThrough: 0,
          execution: null,
          mode: "direct",
          blocked: null,
        },
      },
    } as unknown as ThreadSnapshotResponse,
    reduced.turns(),
  );
  const items = view.items.get(turnId)?.items.map((item) => item.kind);
  expect(items).toEqual(["text"]);

  expect(reduced.hydrate({ turns: [], nextSeq: "103" })).toBe(false);
});
