/**
 * Live-delivery contract for the thread event hub: appending a persisted
 * orchestrator event must publish its projected AG-UI frames to subscribers at
 * append time, not only on journal replay. Background lifecycle events remain
 * journal-only; `subagent.activity` projects the full recomputed activity tree.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent, ThreadActivity } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createNoopEventSink } from "../observability/index.js";
import {
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
} from "./adapters/in-memory/index.js";
import type { SequencedEventInternal } from "./thread-event-hub.js";
import { createThreadEventHub } from "./thread-event-hub.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const PARENT_TURN_ID = "00000000-0000-4000-8000-000000000902";

function createHub() {
  const journal = createInMemoryEventJournalWriter();
  const hub = createThreadEventHub({
    journalWriter: journal,
    journalReader: createInMemoryEventJournalReader(journal),
    eventSink: createNoopEventSink(),
  });
  return { hub, journal };
}

function backgroundEvents(): OrchestratorEvent[] {
  return [
    {
      type: "background.started",
      parentThreadId: THREAD_ID,
      parentTurnId: PARENT_TURN_ID,
      childThreadId: "child-1",
      agentSlug: "code-reviewer",
      description: "Review the chapter",
    },
    {
      type: "background.completed",
      parentThreadId: THREAD_ID,
      parentTurnId: PARENT_TURN_ID,
      childThreadId: "child-1",
      agentSlug: "code-reviewer",
      result: {
        status: "completed",
        report: { handle: "p1", threadId: "child-1", summary: "Done", costMillicredits: 0 },
      },
    },
    {
      type: "background.failed",
      parentThreadId: THREAD_ID,
      parentTurnId: PARENT_TURN_ID,
      childThreadId: "child-1",
      agentSlug: "code-reviewer",
      error: "boom",
    },
  ];
}

describe("thread event hub background journaling", () => {
  it("journals background.* events without projecting a live frame", async () => {
    const { hub } = createHub();
    const received: SequencedEventInternal[] = [];
    hub.subscribe(THREAD_ID, (entry) => received.push(entry));

    for (const event of backgroundEvents()) {
      await hub.appendEvent(THREAD_ID, event);
    }

    expect(received).toEqual([]);
  });

  it("persists the journal row without a projection", async () => {
    const { hub, journal } = createHub();
    const event = backgroundEvents()[0] as OrchestratorEvent;
    await hub.appendEvent(THREAD_ID, event);

    const rows = await journal.readAfter(THREAD_ID, 0n);
    expect(rows.map((row) => row.payload)).toEqual([event]);
  });
});

describe("thread event hub subagent activity", () => {
  it("projects the full recomputed activity as one custom frame", async () => {
    const { hub } = createHub();
    const received: SequencedEventInternal[] = [];
    hub.subscribe(THREAD_ID, (entry) => received.push(entry));

    const activity: ThreadActivity = {
      descendants: [
        {
          threadId: "child-1",
          parentThreadId: THREAD_ID,
          rootThreadId: THREAD_ID,
          depth: 1,
          ref: "p1",
          title: "Review the chapter",
          agentName: "Critic",
          spawnStatus: "running",
          status: { kind: "awake", phase: "generating", cancelRequested: false },
          originTurnId: PARENT_TURN_ID,
        },
      ],
    };
    await hub.appendEvent(THREAD_ID, {
      type: "subagent.activity",
      rootThreadId: THREAD_ID,
      childThreadId: "child-1",
      activity,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.event).toMatchObject({
      type: "CUSTOM",
      name: "meridian.subagent.activity",
      value: activity,
    });
  });
});
