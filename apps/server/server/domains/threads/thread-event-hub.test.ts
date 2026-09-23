/**
 * Live-delivery contract for the thread event hub: appending a persisted
 * orchestrator event must publish its projected AG-UI frames to subscribers at
 * append time, not only on journal replay. Background lifecycle events remain
 * journal-only; `subagent.activity` projects the full recomputed activity tree.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent, ThreadActivity } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { goldenAssistantTurn } from "../../../../../packages/contracts/src/threads/golden/turn-fixture.js";
import { createNoopEventSink } from "../observability/index.js";
import {
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
} from "./adapters/in-memory/index.js";
import type { EventJournalReader, JournalEntry } from "./ports/index.js";
import type { SequencedEventInternal } from "./thread-event-hub.js";
import { createThreadEventHub } from "./thread-event-hub.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901" as ThreadId;
const PARENT_TURN_ID = "00000000-0000-4000-8000-000000000902";

/** A journal reader whose replay window is the first `windowRows` rows. */
function createCappedReader(
  windowRows: number,
  headSeq: bigint,
  withGaps = false,
  payload: OrchestratorEvent | ((index: number) => OrchestratorEvent) = {
    type: "subagent.activity",
    rootThreadId: THREAD_ID,
    childThreadId: "child-1",
    activity: { descendants: [] },
  },
): EventJournalReader {
  const entries: JournalEntry[] = Array.from({ length: windowRows }, (_, index) => ({
    id: `event-${index}`,
    threadId: THREAD_ID,
    turnId: null,
    seq: BigInt(index + 1),
    eventType: (typeof payload === "function" ? payload(index) : payload).type,
    payload: typeof payload === "function" ? payload(index) : payload,
    createdAt: new Date(0).toISOString(),
  })).filter((_, index) => !withGaps || index % 1_000 !== 499);
  return {
    async readAfter(_threadId, afterSeq, limit = Number.POSITIVE_INFINITY) {
      return entries.filter((entry) => entry.seq > afterSeq).slice(0, limit);
    },
    async headSeq() {
      return headSeq;
    },
    async readModelProjectionWatermark() {
      return 0n;
    },
    async listByThread() {
      return entries;
    },
    async listByType() {
      return [];
    },
    async listSince() {
      return [];
    },
    async listByTimeRange() {
      return [];
    },
  };
}

function createCappedHub(
  windowRows: number,
  headSeq: bigint,
  withGaps = false,
  payload?: OrchestratorEvent | ((index: number) => OrchestratorEvent),
) {
  return createThreadEventHub({
    journalWriter: {
      async appendEvent() {
        return 0n;
      },
    },
    journalReader: createCappedReader(windowRows, headSeq, withGaps, payload),
    eventSink: createNoopEventSink(),
  });
}

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

describe("thread event hub committed invalidations", () => {
  for (const failAt of ["head", "page"] as const) {
    it(`evicts idle state after ${failAt} read rejects beyond the grace window`, async () => {
      const journal = createInMemoryEventJournalWriter();
      await journal.appendEvent(THREAD_ID, {
        type: "subagent.activity",
        rootThreadId: THREAD_ID,
        childThreadId: "child",
        activity: { descendants: [] },
      });
      let entered!: () => void;
      let rejectRead!: (error: Error) => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const blocked = new Promise<never>((_resolve, reject) => (rejectRead = reject));
      const reader: EventJournalReader = {
        ...journal,
        async headSeq(threadId) {
          if (failAt === "head") {
            entered();
            return blocked;
          }
          return journal.headSeq(threadId);
        },
        async readAfter(threadId, afterSeq, limit) {
          if (failAt === "page") {
            entered();
            return blocked;
          }
          return journal.readAfter(threadId, afterSeq, limit);
        },
      };
      const hub = createThreadEventHub(
        { journalWriter: journal, journalReader: reader, eventSink: createNoopEventSink() },
        { evictionGraceMs: 5 },
      );
      const unsubscribe = hub.subscribe(THREAD_ID, () => {});
      hub.invalidateCommittedJournal(THREAD_ID);
      await started;
      unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hub.hasThreadState(THREAD_ID)).toBe(true);
      rejectRead(new Error("injected read failure"));
      await vi.waitFor(() => expect(hub.hasThreadState(THREAD_ID)).toBe(false));
    });
  }

  for (const followupFails of [false, true]) {
    it(`retains a requested follow-up drain after rejection, then evicts after ${followupFails ? "failure" : "success"}`, async () => {
      const journal = createInMemoryEventJournalWriter();
      let firstEntered!: () => void;
      let secondEntered!: () => void;
      let rejectFirst!: (error: Error) => void;
      let settleSecond!: (value: bigint) => void;
      let rejectSecond!: (error: Error) => void;
      const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve));
      const secondStarted = new Promise<void>((resolve) => (secondEntered = resolve));
      const first = new Promise<bigint>((_resolve, reject) => (rejectFirst = reject));
      const second = new Promise<bigint>((resolve, reject) => {
        settleSecond = resolve;
        rejectSecond = reject;
      });
      let reads = 0;
      const reader: EventJournalReader = {
        ...journal,
        headSeq() {
          if (++reads === 1) {
            firstEntered();
            return first;
          }
          secondEntered();
          return second;
        },
      };
      const hub = createThreadEventHub(
        { journalWriter: journal, journalReader: reader, eventSink: createNoopEventSink() },
        { evictionGraceMs: 5 },
      );
      const unsubscribe = hub.subscribe(THREAD_ID, () => {});
      hub.invalidateCommittedJournal(THREAD_ID);
      await firstStarted;
      unsubscribe();
      hub.invalidateCommittedJournal(THREAD_ID);
      await new Promise((resolve) => setTimeout(resolve, 20));
      rejectFirst(new Error("first read failed"));
      await secondStarted;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hub.hasThreadState(THREAD_ID)).toBe(true);
      if (followupFails) rejectSecond(new Error("follow-up failed"));
      else settleSecond(0n);
      await vi.waitFor(() => expect(hub.hasThreadState(THREAD_ID)).toBe(false));
    });
  }

  it("keeps one state owner while an unsubscribed thread drain is in flight", async () => {
    const journal = createInMemoryEventJournalWriter();
    const callbacks: Array<() => void | Promise<void>> = [];
    let readStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseRead = resolve));
    const reader = createInMemoryEventJournalReader(journal);
    let blockRead = false;
    const blockingReader: EventJournalReader = {
      ...reader,
      async headSeq(threadId) {
        return reader.headSeq(threadId);
      },
      async readAfter(threadId, afterSeq, limit) {
        if (blockRead) {
          blockRead = false;
          readStarted();
          await blocked;
        }
        return reader.readAfter(threadId, afterSeq, limit);
      },
    };
    const hub = createThreadEventHub(
      {
        journalWriter: journal,
        journalReader: blockingReader,
        eventSink: createNoopEventSink(),
        scheduleAfterCommit(callback) {
          callbacks.push(callback);
        },
      },
      { evictionGraceMs: 1 },
    );
    const unsubscribe = hub.subscribe(THREAD_ID, () => {});
    blockRead = true;
    await hub.appendEvent(THREAD_ID, { type: "stream.delta", kind: "text", text: "a" });
    callbacks[0]?.();
    await started;
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hub.hasThreadState(THREAD_ID)).toBe(true);

    releaseRead();
    await hub.catchup(THREAD_ID, 0n);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hub.hasThreadState(THREAD_ID)).toBe(false);
  });

  it("keeps delayed text and tool projection on one side of the replay boundary", async () => {
    const journal = createInMemoryEventJournalWriter();
    const reader = createInMemoryEventJournalReader(journal);
    await journal.appendEvent(THREAD_ID, {
      type: "turn.created",
      turn: goldenAssistantTurn("turn-handoff", THREAD_ID),
    });
    await journal.appendEvent(THREAD_ID, { type: "stream.delta", kind: "text", text: "a" });
    await journal.appendEvent(THREAD_ID, {
      type: "stream.delta",
      kind: "tool_call",
      toolCallId: "tool-handoff",
      toolName: "lookup",
      argumentsDelta: "{}",
    });
    for (let i = 0; i < 498; i++) {
      await journal.appendEvent(THREAD_ID, {
        type: "background.started",
        parentThreadId: THREAD_ID,
        parentTurnId: PARENT_TURN_ID,
        childThreadId: `background-${i}`,
        agentSlug: "reviewer",
        description: "No live projection",
      });
    }

    let replayReadStarted!: () => void;
    let releaseReplayRead!: () => void;
    const replayStarted = new Promise<void>((resolve) => (replayReadStarted = resolve));
    const replayBlocked = new Promise<void>((resolve) => (releaseReplayRead = resolve));
    let blockReplay = false;
    const blockingReader: EventJournalReader = {
      ...reader,
      async readAfter(threadId, afterSeq, limit) {
        if (blockReplay) {
          blockReplay = false;
          replayReadStarted();
          await replayBlocked;
        }
        return reader.readAfter(threadId, afterSeq, limit);
      },
    };
    const hub = createThreadEventHub({
      journalWriter: journal,
      journalReader: blockingReader,
      eventSink: createNoopEventSink(),
    });
    await hub.catchup(THREAD_ID, 0n);
    blockReplay = true;
    const live: SequencedEventInternal[] = [];
    const handoffPromise = hub.catchupAndSubscribe(THREAD_ID, 0n, (entry) => live.push(entry));
    await replayStarted;

    await journal.appendEvent(THREAD_ID, { type: "stream.delta", kind: "text", text: "b" });
    await journal.appendEvent(THREAD_ID, {
      type: "tool.result",
      toolCallId: "tool-handoff",
      output: "complete",
      isError: false,
    });
    releaseReplayRead();
    const handoff = await handoffPromise;
    hub.invalidateCommittedJournal(THREAD_ID);
    await hub.catchup(THREAD_ID, 0n);

    const delivered = [...handoff.catchup, ...live];
    const finalText = delivered.filter((entry) => entry.event.type === "TEXT_MESSAGE_CONTENT");
    expect(
      finalText.filter(
        (entry) => entry.event.type === "TEXT_MESSAGE_CONTENT" && entry.event.delta === "b",
      ),
    ).toHaveLength(1);
    expect(finalText.at(-1)?.event).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "b" });
    expect(finalText.at(-1)?.event).toMatchObject({ messageId: expect.any(String) });
    const toolResults = delivered.filter((entry) => entry.event.type === "TOOL_CALL_RESULT");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      seq: 503_002n,
      event: { type: "TOOL_CALL_RESULT", toolCallId: "tool-handoff", content: "complete" },
    });
    handoff.unsubscribe();
  });

  it("serializes reversed and duplicate invalidations through journal order", async () => {
    const journal = createInMemoryEventJournalWriter();
    const callbacks: Array<() => void | Promise<void>> = [];
    const hub = createThreadEventHub({
      journalWriter: journal,
      journalReader: createInMemoryEventJournalReader(journal),
      eventSink: createNoopEventSink(),
      scheduleAfterCommit(callback) {
        callbacks.push(callback);
      },
    });
    const received: SequencedEventInternal[] = [];
    hub.subscribe(THREAD_ID, (entry) => received.push(entry));

    for (const marker of ["one", "two", "three"]) {
      await hub.appendEvent(THREAD_ID, {
        type: "subagent.activity",
        rootThreadId: THREAD_ID,
        childThreadId: marker,
        activity: { descendants: [{ threadId: marker }] } as ThreadActivity,
      });
    }

    await callbacks[2]?.();
    await callbacks[0]?.();
    await callbacks[2]?.();
    await callbacks[1]?.();
    await hub.catchup(THREAD_ID, 0n);

    expect(received.map((entry) => entry.seq)).toEqual([1_000n, 2_000n, 3_000n]);
    expect(received.map((entry) => entry.event)).toHaveLength(3);
  });

  it("keeps a committed append made during cold replay in the live handoff", async () => {
    const journal = createInMemoryEventJournalWriter();
    const reader = createInMemoryEventJournalReader(journal);
    const firstEvent: OrchestratorEvent = {
      type: "subagent.activity",
      rootThreadId: THREAD_ID,
      childThreadId: "before-replay",
      activity: { descendants: [] },
    };
    await journal.appendEvent(THREAD_ID, firstEvent);

    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let blockFirstRead = true;
    const blockingReader: EventJournalReader = {
      readAfter: async (threadId, afterSeq, limit) => {
        if (blockFirstRead) {
          blockFirstRead = false;
          markReadStarted();
          await blockedRead;
        }
        return reader.readAfter(threadId, afterSeq, limit);
      },
      headSeq: (threadId) => reader.headSeq(threadId),
      readModelProjectionWatermark: (threadId) => reader.readModelProjectionWatermark(threadId),
      listByThread: (threadId, opts) => reader.listByThread(threadId, opts),
      listByType: (threadId, type) => reader.listByType(threadId, type),
      listSince: (threadId, id) => reader.listSince(threadId, id),
      listByTimeRange: (threadId, from, to) => reader.listByTimeRange(threadId, from, to),
    };
    const hub = createThreadEventHub({
      journalWriter: journal,
      journalReader: blockingReader,
      eventSink: createNoopEventSink(),
    });
    const live: SequencedEventInternal[] = [];
    const handoff = hub.catchupAndSubscribe(THREAD_ID, 0n, (entry) => live.push(entry));
    await readStarted;
    await journal.appendEvent(THREAD_ID, {
      type: "subagent.activity",
      rootThreadId: THREAD_ID,
      childThreadId: "during-replay",
      activity: { descendants: [] },
    });
    hub.invalidateCommittedJournal(THREAD_ID);
    releaseRead();

    const subscription = await handoff;
    await hub.catchup(THREAD_ID, 0n);
    const delivered = [...subscription.catchup, ...live]
      .map((entry) => entry.seq)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(delivered).toEqual([1_000n, 2_000n]);
    subscription.unsubscribe();
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

describe("thread event hub complete replay", () => {
  it("replays all rows beyond 10k through the captured head", async () => {
    const headJournalSeq = 23_081n;
    const headCursor = headJournalSeq * 1_000n + 999n;
    const behind = await createCappedHub(23_081, headJournalSeq).catchupAndSubscribe(
      THREAD_ID,
      0n,
      () => {},
    );
    expect(behind.catchup).toHaveLength(23_081);
    expect(behind.catchup.at(-1)?.seq).toBe(headJournalSeq * 1_000n);
    behind.unsubscribe();

    const atHead = await createCappedHub(23_081, headJournalSeq).catchupAndSubscribe(
      THREAD_ID,
      headCursor,
      () => {},
    );
    expect(atHead.catchup).toEqual([]);
    atHead.unsubscribe();
  });

  it("reconstructs and sends the suffix of a long active text segment", async () => {
    const rowCount = 23_081;
    const payload = (index: number): OrchestratorEvent =>
      index === 0
        ? { type: "turn.created", turn: goldenAssistantTurn("turn-long", THREAD_ID) }
        : { type: "stream.delta", kind: "text", text: "x" };
    const suffixStart = 20_000n;
    const suffixAfter = suffixStart * 1_000n + 999n;
    const replay = await createCappedHub(
      rowCount,
      BigInt(rowCount),
      false,
      payload,
    ).catchupAndSubscribe(THREAD_ID, suffixAfter, () => {});
    expect(replay.catchup).toHaveLength(rowCount - Number(suffixStart));
    expect(replay.catchup[0]?.seq).toBe((suffixStart + 1n) * 1_000n);
    expect(replay.catchup.at(-1)?.seq).toBe(BigInt(rowCount) * 1_000n);
    expect(replay.catchup.at(-1)?.event).toMatchObject({
      type: "TEXT_MESSAGE_CONTENT",
      delta: "x",
    });
    replay.unsubscribe();
  });

  it("does not treat legal sequence gaps as a missing replay page", async () => {
    const rowCount = 23_081;
    const headJournalSeq = BigInt(rowCount);
    const replay = await createCappedHub(rowCount, headJournalSeq, true).catchupAndSubscribe(
      THREAD_ID,
      0n,
      () => {},
    );
    expect(replay.catchup).toHaveLength(rowCount - 23);
    expect(replay.catchup.at(-1)?.seq).toBe(headJournalSeq * 1_000n);
    replay.unsubscribe();
  });
});
