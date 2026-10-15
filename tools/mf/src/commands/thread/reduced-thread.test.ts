/** The snapshot/replay boundary: freshness (`nextSeq`) and replay coverage (`resumeAfterSeq`) are separate facts. */
import type { AGUIEvent, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { EventType, WRITE_MODE_SWITCHED_EVENT } from "@meridian/contracts/protocol";
import {
  GOLDEN_ASSISTANT_TURN_ID,
  GOLDEN_THREAD_ID,
  SIMPLE_TEXT_TURN_AGUI,
} from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import { createSession } from "../../core/session";
import { startWire } from "../../test-support/wire";
import {
  COOKIE,
  replyTurn,
  snapshotOf,
  THREAD_ID,
  userTurn,
} from "../../test-support/wire-fixtures";
import { viewSnapshot } from "./chat-view";
import { ReducedThread } from "./reduced-thread";
import { replyText } from "./reply-text";
import { followThread } from "./stream";

const THREAD = GOLDEN_THREAD_ID;
const event = (value: Record<string, unknown>) => value as unknown as AGUIEvent;

it("applies journal-only deltas between the replay cursor and nextSeq, and rejects only stale snapshots", async () => {
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

  // Risk: a follow that starts with no hydration holds a `switched` divider forever when the
  // frame names a user turn the stream never carries. The real follow path asks for a snapshot
  // and the divider lands after that turn; a covering snapshot that excludes it releases the hold.
  const wire = await startWire();
  try {
    // The server stores the divider after the user turn; the snapshot covers its frame.
    wire.snapshot = snapshotOf({
      seq: 1,
      turns: [userTurn("u1", 1, "hi"), replyTurn("sys-2", 2, { prevTurnId: "u1" })],
    });
    wire.publish(
      event({
        type: EventType.CUSTOM,
        name: WRITE_MODE_SWITCHED_EVENT,
        value: {
          threadId: THREAD_ID,
          mode: "draft",
          controlId: "c2",
          turnId: "sys-2",
          prevTurnId: "u1",
          position: 1,
        },
      }),
    );
    const followed = new ReducedThread(THREAD_ID);
    await followThread({
      session: createSession({ serverUrl: wire.baseUrl, cookie: COOKIE, ca: undefined }),
      threadId: THREAD_ID,
      lastSeq: "0",
      deadlineAt: Date.now() + 5000,
      out: { record() {} } as never,
      full: false,
      textStream: "err",
      catchupOnly: true,
      reduced: followed,
    });
    expect(followed.turns().map((turn) => turn.id)).toEqual(["u1", "sys-2"]);
    expect(followed.awaitsAnchor()).toBe(false);
    // Recovery overwrote the stream's evidence: comparing now would measure the server against itself.
    expect(followed.compare(wire.snapshot, ["sys-2"], false)).toEqual({ liveView: "not_observed" });
    // A start frame queued behind the recovery must not make the snapshot's text stream evidence again.
    followed.apply(
      event({ type: EventType.RUN_STARTED, threadId: THREAD_ID, runId: "sys-2" }),
      "2",
    );
    expect(followed.compare(wire.snapshot, ["sys-2"], false)).toEqual({ liveView: "not_observed" });
  } finally {
    await wire.close();
  }
});
