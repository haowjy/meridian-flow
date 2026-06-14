/**
 * Replay fidelity tests — prove the thread event hub's live persistent-projector
 * path and fresh journal-replay path emit the same AG-UI stream for a long mixed
 * turn that exceeds the hot-cache window.
 */

import { EventType } from "@meridian/contracts/protocol";
import {
  GOLDEN_THREAD_ID,
  goldenAssistantTurn,
  type OrchestratorEvent,
} from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../observability/index.js";

import { createInMemoryEventJournalWriter } from "./adapters/in-memory/event-writer.js";
import { createThreadEventHub, type SequencedEventInternal } from "./thread-event-hub.js";

const EVENT_SEQ_FACTOR = 1_000n;

function buildLongMixedTurnEvents(): {
  threadId: string;
  turnId: string;
  events: OrchestratorEvent[];
} {
  const threadId = `${GOLDEN_THREAD_ID}_replay_fidelity`;
  const turnId = "turn_replay_fidelity";
  const events: OrchestratorEvent[] = [
    {
      type: "turn.created",
      turn: goldenAssistantTurn(turnId, threadId),
    },
    { type: "stream.delta", kind: "text", text: "Intro. " },
    { type: "stream.delta", kind: "reasoning", text: "Need to inspect tools first. " },
    { type: "stream.delta", kind: "text", text: "Starting analysis. " },
  ];

  for (let index = 0; index < 180; index += 1) {
    const toolCallId = `call_replay_${index}`;
    events.push(
      {
        type: "stream.delta",
        kind: "tool_call",
        toolCallId,
        toolName: "read_file",
        argumentsDelta: `{"index":${index},"path":"`,
      },
      {
        type: "stream.delta",
        kind: "tool_call",
        toolCallId,
        toolName: "read_file",
        argumentsDelta: `/tmp/input-${index}.txt"}`,
      },
      {
        type: "tool.result",
        toolCallId,
        output: `tool-output-${index}`,
      },
      {
        type: "stream.delta",
        kind: "text",
        text: `Tail ${index}. `,
      },
    );

    if (index % 30 === 0) {
      events.push(
        {
          type: "stream.delta",
          kind: "reasoning",
          text: `Reasoning checkpoint ${index}. `,
        },
        {
          type: "stream.delta",
          kind: "text",
          text: `Resume ${index}. `,
        },
      );
    }
  }

  events.push({
    type: "turn.completed",
    turn: goldenAssistantTurn(turnId, threadId, "complete"),
  });

  return { threadId, turnId, events };
}

function journalSeqCounts(events: SequencedEventInternal[]): number[] {
  const counts = new Map<bigint, number>();
  for (const entry of events) {
    const journalSeq = entry.seq / EVENT_SEQ_FACTOR;
    counts.set(journalSeq, (counts.get(journalSeq) ?? 0) + 1);
  }
  return [...counts.values()];
}

describe("thread event hub replay fidelity", () => {
  it("replays the exact same AG-UI stream the live persistent projector emitted", async () => {
    const journal = createInMemoryEventJournalWriter();
    const hub = createThreadEventHub({
      journalWriter: journal,
      journalReader: journal,
      eventSink: createInMemoryEventSink(),
    });
    const { threadId, turnId, events } = buildLongMixedTurnEvents();
    const live: SequencedEventInternal[] = [];

    const unsubscribe = hub.subscribe(threadId, (entry) => {
      live.push(entry);
    });

    for (const event of events) {
      await hub.appendEvent(threadId, event);
    }
    unsubscribe();

    expect(live.length).toBeGreaterThan(500);

    const replayAll = await hub.catchup(threadId, 0n);
    expect(replayAll).toEqual(live);

    const replayCursor = live.at(-700)?.seq;
    expect(replayCursor).toBeTypeOf("bigint");
    const replayTail = await hub.catchup(threadId, replayCursor ?? 0n);
    expect(replayTail).toEqual(live.filter((entry) => entry.seq > (replayCursor ?? 0n)));

    const textStarts = live.filter((entry) => entry.event.type === EventType.TEXT_MESSAGE_START);
    expect(textStarts.length).toBeGreaterThan(2);
    // Re-narrow inside the map: a boolean filter predicate doesn't narrow the
    // AGUIEvent union element type, so read messageId under a type guard.
    const textIds = textStarts.map((entry) =>
      entry.event.type === EventType.TEXT_MESSAGE_START ? entry.event.messageId : "",
    );
    expect(new Set(textIds).size).toBe(textIds.length);
    expect(textIds.every((messageId) => messageId.startsWith(`${turnId}::`))).toBe(true);

    const reasoningStarts = live.filter(
      (entry) => entry.event.type === EventType.REASONING_MESSAGE_START,
    );
    expect(reasoningStarts.length).toBeGreaterThan(1);
    expect(new Set(reasoningStarts.map((entry) => entry.event.messageId)).size).toBe(
      reasoningStarts.length,
    );

    const perJournalEventCounts = journalSeqCounts(live);
    expect(Math.max(...perJournalEventCounts)).toBeLessThan(Number(EVENT_SEQ_FACTOR));

    const journalEntries = await journal.listByThread(threadId);
    expect(journalEntries.map((entry) => entry.payload)).toEqual(events);
  });
});
