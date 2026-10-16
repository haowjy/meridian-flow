/**
 * The thread sync's rules against a scripted transport: what a stream does to the turns while reads
 * are withheld, when it asks for a read, and the end-of-turn check. Fetching, storage and effects
 * are the host's and are not here.
 */
import {
  type AGUIEvent,
  EventType,
  type ThreadSnapshotResponse,
  type Turn,
} from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTransport, ThreadTransportHandlers } from "../socket/thread-transport";
import { EMPTY_SYNCED_THREAD, type SyncedThread } from "./synced-thread";
import { createThreadSync, type SyncObservation } from "./thread-sync";

const THREAD = "thread-1";

const IDLE = {
  version: "0",
  items: [],
  sentThrough: 0,
  execution: null,
  mode: "direct",
  blocked: null,
} as RunState;

afterEach(() => vi.useRealTimers());

function harness(initial: SyncedThread = EMPTY_SYNCED_THREAD) {
  let synced = initial;
  const subscriptions: Array<{ handlers: ThreadTransportHandlers; active: boolean }> = [];
  const requests: string[] = [];
  const observations: SyncObservation[] = [];
  const transport = {
    subscribe(_threadId: string, handlers: ThreadTransportHandlers) {
      const entry = { handlers, active: true };
      subscriptions.push(entry);
      return () => {
        entry.active = false;
      };
    },
  } as unknown as ThreadTransport;
  const sync = createThreadSync({
    threadId: THREAD,
    transport,
    state: { get: () => synced, set: (next) => (synced = next) },
    requestSnapshot: (kind) => requests.push(kind),
    observe: (observation) => observations.push(observation),
    signal: new AbortController().signal,
    now: () => "2026-01-01T00:00:00.000Z",
    // Buffered deltas flush when the next frame, a read or a stop asks, never on a timer.
    scheduleFlush: () => () => undefined,
  });
  sync.start();
  return {
    sync,
    requests,
    subscriptions,
    synced: () => synced,
    turn: (id: string) => synced.turns.find((turn) => turn.id === id),
    checks: () =>
      observations.filter(
        (observation): observation is Extract<SyncObservation, { kind: "check" }> =>
          observation.kind === "check",
      ),
    emit(event: Record<string, unknown>, seq: string) {
      for (const entry of subscriptions) {
        if (entry.active) entry.handlers.onEvent({ seq, event: event as unknown as AGUIEvent });
      }
    },
  };
}

type Harness = ReturnType<typeof harness>;

function textBlock(id: string, turnId: string, text: string) {
  return {
    id,
    turnId,
    responseId: null,
    blockType: "text",
    sequence: 0,
    content: { text },
    textContent: text,
    status: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function reply(id: string, status: string, text: string, extra: object = {}): Turn {
  return {
    id,
    threadId: THREAD,
    role: "assistant",
    status,
    blocks: text ? [textBlock("m1", id, text)] : [],
    ...extra,
  } as unknown as Turn;
}

function read(turns: Turn[], nextSeq: string, runState: RunState = IDLE): ThreadSnapshotResponse {
  return {
    thread: { id: THREAD, projectId: "project-1", userId: "account-1" },
    turns,
    nextSeq,
    actionRequired: false,
    liveState: { runningTurnId: null, resumeAfterSeq: nextSeq, runState },
  } as unknown as ThreadSnapshotResponse;
}

const runStarted = (runId: string) => ({
  type: EventType.RUN_STARTED,
  threadId: THREAD,
  runId,
  rawEvent: { writeMode: null },
});
const runFinished = (runId: string) => ({ type: EventType.RUN_FINISHED, threadId: THREAD, runId });
const textStart = (messageId: string) => ({ type: EventType.TEXT_MESSAGE_START, messageId });
const textDelta = (messageId: string, delta: string) => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta,
});
const custom = (name: string, value: unknown) => ({ type: EventType.CUSTOM, name, value });
const card = (status: string) =>
  custom("meridian.block.upserted", {
    block: {
      id: "card-1",
      turnId: "turn-1",
      blockType: "custom",
      sequence: 4,
      content: { kind: "spawn", props: { status, toolCallId: "call-1", execution: "child-turn" } },
    },
  });
const interrupt = (turnId: string, state: "created" | "resolved") =>
  custom("meridian.interrupt", {
    state,
    turnId,
    interruptId: "int-1",
    blockSequence: 3,
    ...(state === "resolved" ? { value: "yes", provenance: "user" } : {}),
  });
const record = (version: string, executionId: string | null, items: unknown[] = []) =>
  custom("meridian.run_state", {
    ...IDLE,
    version,
    items,
    execution: executionId ? { executionId, currentTurnId: null } : null,
  });

describe.each([
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
])("durable owner after %s", (terminal) => {
  it("replaces the original historical card with reads withheld and no new run", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(runStarted("turn-1"), "1000");
    h.emit(card("running"), "2000");
    h.emit({ type: terminal, threadId: THREAD, runId: "turn-1" }, "3000");
    await vi.advanceTimersByTimeAsync(260);
    expect(h.subscriptions.filter((entry) => entry.active)).toHaveLength(1);
    const before = h.synced().turns[0];
    expect(before?.blocks[0]?.id).toBe("card-1");
    h.emit(card("completed"), "4000");
    const after = h.synced().turns[0];
    expect(after?.blocks[0]?.content).toMatchObject({
      props: { status: "completed", toolCallId: "call-1", execution: "child-turn" },
    });
    expect(after?.status).not.toBe("streaming");
    expect(after?.blocks[0]?.sequence).toBe(before?.blocks[0]?.sequence);
  });
});

describe("frame order", () => {
  it("flushes buffered deltas before a durable block, and before a read lands", () => {
    const h = harness();
    h.emit(runStarted("turn-1"), "1000");
    h.emit(textStart("text-1"), "1100");
    h.emit(textDelta("text-1", "hello"), "1200");
    h.emit(card("running"), "1300");
    const blocks = h.turn("turn-1")?.blocks;
    expect(blocks?.find((block) => block.id === "text-1")?.textContent).toBe("hello");
    expect(blocks?.find((block) => block.id === "card-1")?.content).toMatchObject({
      props: { status: "running" },
    });
    expect(h.synced().eventsApplied).toBe(3);

    // Fix 1: a delta buffered before a read belongs before it, not appended to the read's text.
    h.emit(textDelta("text-1", " world"), "1400");
    h.sync.receive(read([reply("turn-1", "streaming", "hello world")], "1500"));
    const text = h.turn("turn-1")?.blocks.find((block) => block.id === "m1")?.textContent;
    expect(text).toBe("hello world");
    expect(h.turn("turn-1")?.blocks.find((block) => block.id === "text-1")?.textContent).not.toBe(
      "hello world world",
    );
  });
});

describe("when the sync asks for a read", () => {
  it("revalidates as a run ends, on a record whose execution changed, and on every status frame", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sync.receive(read([], "1000"));
    const settle = () => vi.advanceTimersByTimeAsync(300);
    // A divider reserves: the record's execution changed.
    h.emit(record("1000", "e1"), "1000");
    await settle();
    expect(h.requests).toEqual(["fresh"]);
    // The same execution, and an older record, change nothing.
    h.emit(record("1500", "e1"), "1500");
    h.emit(record("900", null), "1501");
    await settle();
    expect(h.requests).toHaveLength(1);
    // Frames inside one debounce window share a single refresh.
    h.emit(record("2000", null), "2000");
    h.emit(record("2001", "e2"), "2001");
    await settle();
    expect(h.requests).toHaveLength(2);
    // A record naming another client's waiting message revalidates once: the stream does not
    // carry that user turn.
    const waiting = [
      {
        id: "foreign-1",
        intent: "message",
        seq: 1,
        provenance: { kind: "writer", actorId: "u1" },
        deliveryState: "waiting",
        summary: "M2",
        enqueuedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    h.emit(record("2500", "e2", waiting), "2500");
    h.emit(record("2501", "e2", waiting), "2501");
    await settle();
    expect(h.requests).toHaveLength(3);
    // The run's end revalidates too (the turn's own terminal write may add one more).
    h.emit(runFinished("a"), "3000");
    await settle();
    const afterRun = h.requests.length;
    expect(afterRun).toBeGreaterThan(3);
    // A handoff brief starts and ends with no run: only its status frame says so.
    h.emit(
      custom("meridian.thread.status", {
        threadId: THREAD,
        status: { kind: "asleep" },
        runningTurnId: null,
      }),
      "4000",
    );
    await settle();
    expect(h.requests.length).toBeGreaterThan(afterRun);
  });

  it("settles a stopped autocompaction from the record its lease release sends", async () => {
    // A cancelled autocompaction projects no RUN_FINISHED; the record whose execution closed
    // is its only signal.
    vi.useFakeTimers();
    const compaction = (status: string) =>
      ({
        id: "c",
        threadId: THREAD,
        role: "compaction",
        status,
        position: 3,
        blocks: [],
        metadata: { kind: "compaction", trigger: "auto" },
      }) as unknown as Turn;
    const h = harness();
    h.sync.receive(
      read([compaction("pending")], "1000", {
        ...IDLE,
        version: "1000",
        execution: { executionId: "e-c", currentTurnId: "c" },
      } as RunState),
    );
    expect(h.turn("c")?.status).toBe("pending");
    h.emit(record("2000", null), "2000");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.requests).toEqual(["fresh"]);
    h.sync.receive(read([compaction("cancelled")], "2000", { ...IDLE, version: "2000" }));
    expect(h.turn("c")?.status).toBe("cancelled");
  });
});

describe("the end-of-turn check", () => {
  /** The stream ends `turnId` after replay reopened it: interrupt created, resolved, then the end. */
  function reopenAndEnd(h: Harness, turnId: string, end: "finish" | "error") {
    h.emit(interrupt(turnId, "created"), "5001");
    h.emit(interrupt(turnId, "resolved"), "5002");
    h.emit(textDelta("m1", "Done"), "5003");
    h.emit(
      end === "finish"
        ? runFinished(turnId)
        : { type: EventType.RUN_ERROR, threadId: THREAD, message: "boom" },
      "5004",
    );
  }

  it("compares a stream-ended turn with the read, and never trusts a turn a read wrote first", () => {
    // A stream that ends a turn with text the read doesn't hold is a difference.
    const differs = harness();
    differs.emit(runStarted("turn-a"), "1000");
    differs.emit(textStart("m1"), "1100");
    differs.emit(textDelta("m1", "Hello"), "1200");
    differs.emit(runFinished("turn-a"), "1300");
    differs.sync.receive(read([reply("turn-a", "complete", "Hello world")], "2000"));
    expect(differs.checks()).toEqual([
      {
        kind: "check",
        turnId: "turn-a",
        rewritten: false,
        diffs: [{ turnId: "turn-a", field: "finalText", live: "Hello", server: "Hello world" }],
      },
    ]);

    // A read that changes a running turn marks it rewritten, and its later clean check says so.
    const changed = harness();
    changed.emit(runStarted("turn-b"), "1000");
    changed.emit(textStart("m1"), "1100");
    changed.emit(textDelta("m1", "Hi"), "1200");
    changed.sync.receive(read([reply("turn-b", "streaming", "Hi there")], "2000"));
    changed.emit(runFinished("turn-b"), "2100");
    changed.sync.receive(read([reply("turn-b", "complete", "Hi there")], "3000"));
    expect(changed.checks()).toEqual([
      { kind: "check", turnId: "turn-b", rewritten: true, diffs: [] },
    ]);

    // A turn a read showed terminal, reopened by replayed interrupt frames and ended again by
    // RUN_FINISHED, stays rewritten; so does a second one from `error` after a delta the read covered.
    const finished = harness();
    finished.sync.receive(read([reply("turn-c", "complete", "Done")], "2000"));
    reopenAndEnd(finished, "turn-c", "finish");
    expect(finished.turn("turn-c")?.status).toBe("complete");
    finished.sync.receive(read([reply("turn-c", "complete", "Done")], "6000"));
    expect(finished.checks().map((check) => [check.turnId, check.rewritten])).toEqual([
      ["turn-c", true],
    ]);
    const failed = harness();
    failed.sync.receive(read([reply("turn-d", "error", "Done")], "2000"));
    reopenAndEnd(failed, "turn-d", "error");
    failed.sync.receive(read([reply("turn-d", "error", "Done")], "6000"));
    expect(failed.checks().map((check) => [check.turnId, check.rewritten])).toEqual([
      ["turn-d", true],
    ]);

    // A first read that installs the turn streaming with text, followed only by its end, stays
    // rewritten: no frame delivered that text.
    const seeded = harness();
    seeded.sync.receive(read([reply("turn-e", "streaming", "Part")], "2000"));
    seeded.emit(runFinished("turn-e"), "2100");
    seeded.sync.receive(read([reply("turn-e", "complete", "Part")], "3000"));
    expect(seeded.checks().map((check) => [check.turnId, check.rewritten])).toEqual([
      ["turn-e", true],
    ]);

    // So does a kept cell that already holds the turn's text when a new sync starts.
    const kept = harness({
      ...EMPTY_SYNCED_THREAD,
      turns: [reply("turn-f", "streaming", "Part")],
    });
    kept.emit(runFinished("turn-f"), "2100");
    kept.sync.receive(read([reply("turn-f", "complete", "Part")], "3000"));
    expect(kept.checks().map((check) => [check.turnId, check.rewritten])).toEqual([
      ["turn-f", true],
    ]);

    // Forgetting is not compared: a read that stamps a stream-ended turn checks clean.
    const forgotten = harness();
    forgotten.emit(runStarted("turn-g"), "1000");
    forgotten.emit(textStart("m1"), "1100");
    forgotten.emit(textDelta("m1", "ok"), "1200");
    forgotten.emit(runFinished("turn-g"), "1300");
    forgotten.sync.receive(
      read([reply("turn-g", "complete", "ok", { forgottenBy: "turn-h" })], "2000"),
    );
    expect(forgotten.checks()).toEqual([
      { kind: "check", turnId: "turn-g", rewritten: false, diffs: [] },
    ]);
  });
});
