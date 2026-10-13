/** The snapshot/replay boundary: freshness (`nextSeq`) and replay coverage (`resumeAfterSeq`) are separate facts. */
import type { AGUIEvent, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { ReducedThread } from "./reduced-thread";
import { assistantText } from "./transcript";

const THREAD = "thread-1";
const event = (value: Record<string, unknown>) => value as unknown as AGUIEvent;

it("applies journal-only deltas between the replay cursor and nextSeq, and rejects only stale snapshots", () => {
  const reduced = new ReducedThread(THREAD);
  // The projection stopped at seq 97 while the journal head is 103: deltas 98..103 exist only as events.
  expect(reduced.hydrate({ turns: [], nextSeq: "104" })).toBe(true);
  const replay = [
    event({ type: EventType.RUN_STARTED, runId: "turn-1" }),
    event({ type: EventType.TEXT_MESSAGE_START, messageId: "m1" }),
    event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hel" }),
    event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "lo" }),
    event({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
    event({ type: EventType.RUN_FINISHED, runId: "turn-1" }),
  ];
  replay.forEach((item) => {
    reduced.apply(item);
  });

  const stored = { turns: reduced.turns(), nextSeq: "104" } as unknown as ThreadSnapshotResponse;
  expect(reduced.turn("turn-1")?.status).toBe("complete");
  expect(reduced.compare(stored, ["turn-1"])).toEqual({ liveView: "matches" });
  expect(assistantText(reduced.turn("turn-1"))).toBe("Hello");

  expect(reduced.hydrate({ turns: [], nextSeq: "103" })).toBe(false);
});
