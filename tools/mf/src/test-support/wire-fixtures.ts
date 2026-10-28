/**
 * Typed contract fixtures for the wire harness: threads, turns, run-state records, snapshots and
 * frames built from `@meridian/contracts`, and `replyScenario`, which states the facts of a
 * writer message and the reply that answers it.
 */
import type { AGUIEvent, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import type { Block, PendingInboxItem, RunState, Thread, Turn } from "@meridian/contracts/threads";
import type { Wire } from "./wire";

export const COOKIE = "wos-session=test";
export const THREAD_ID = "11111111-1111-4111-8111-111111111111";
export const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
/** Longer than the text-mode diff clip, so `--full` is observable. */
export const DIVERGED_STORED_TEXT = `Stored answer ${"x".repeat(200)}`;

export function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    workId: null,
    aiWriteMode: "direct",
    effectiveAiWriteMode: "direct",
    userId: "u1",
    kind: "primary",
    status: "idle",
    title: "Wire thread",
    ref: "c1",
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: "General",
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: THREAD_ID,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
  };
}

export function recordOf(over: Partial<RunState> = {}): RunState {
  return {
    version: "0",
    items: [],
    sentThrough: 0,
    execution: null,
    mode: "direct",
    blocked: null,
    ...over,
  };
}

export function inboxItem(id: string, seq: number, summary = id): PendingInboxItem {
  return {
    id,
    seq,
    intent: "message",
    provenance: { kind: "writer", actorId: "u1" },
    deliveryState: "waiting",
    summary,
    enqueuedAt: "2026-01-02T00:00:00.000Z",
  };
}

export function block(turnId: string, sequence: number, over: Partial<Block>): Block {
  return {
    id: `${turnId}-b${sequence}`,
    turnId,
    responseId: null,
    blockType: "text",
    sequence,
    content: "",
    createdAt: "2026-01-01T00:00:03.000Z",
    ...over,
  };
}

type TurnOver = Partial<Turn> & { id: string; position: number };

function turnOf(over: TurnOver): Turn {
  return {
    threadId: THREAD_ID,
    role: "assistant",
    origin: "assistant",
    writeMode: null,
    status: "complete",
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
    promptBakeId: null,
    finishReason: null,
    inputTokens: 1,
    outputTokens: 2,
    totalCostUsd: "0",
    responseCount: 1,
    usage: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
    forgottenBy: null,
    ...over,
  };
}

/** A writer message; `deliveredBy` undefined means nobody has taken it (no delivery at all). */
export function userTurn(
  id: string,
  position: number,
  text: string,
  deliveredBy?: string | null,
): Turn {
  return turnOf({
    id,
    position,
    role: "user",
    origin: "writer",
    delivery: deliveredBy === undefined ? null : { byTurnId: deliveredBy },
    blocks: [block(id, 0, { content: text, textContent: text })],
  });
}

/** A reply turn; its text is stored as one text block, as the server's projection does. */
export function replyTurn(
  id: string,
  position: number,
  over: Partial<Turn> & { text?: string } = {},
): Turn {
  const { text, ...rest } = over;
  return turnOf({
    id,
    position,
    executionId: `exec-${id}`,
    blocks: text ? [block(id, 0, { content: text, textContent: text })] : [],
    ...rest,
  });
}

/** One snapshot read. `seq` is the journal head the read was made at. */
export function snapshotOf(
  o: { turns?: Turn[]; record?: Partial<RunState>; seq?: number; awake?: boolean } = {},
): ThreadSnapshotResponse {
  const seq = String(o.seq ?? 0);
  return {
    threadId: THREAD_ID,
    thread: thread(),
    turns: o.turns ?? [],
    asks: [],
    threadUsage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheReportedInputTokens: 0,
      cacheReportedCalls: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      cacheResets: 0,
    },
    liveState: {
      threadId: THREAD_ID,
      status: o.awake
        ? { kind: "awake", phase: "generating", cancelRequested: false }
        : { kind: "asleep" },
      activity: { children: [] },
      runState: recordOf({ version: seq, ...o.record }),
      resumeAfterSeq: seq,
    },
    actionRequired: false,
    nextSeq: String(Number(seq) + 1),
    ancestors: [],
  };
}

/** A snapshot where reply `id` holds the chat's execution open. */
export const openReply = (id: string, seq = 0) =>
  snapshotOf({
    seq,
    turns: [replyTurn(id, 1, { status: "streaming" })],
    record: { execution: { executionId: `exec-${id}`, currentTurnId: id } },
  });

/** Frames are built loosely typed: the union's variants carry fields the CLI never reads. */
const frame = (value: Record<string, unknown>) => value as unknown as AGUIEvent;

export const frames = {
  started: (runId: string) =>
    frame({ type: "RUN_STARTED", threadId: THREAD_ID, runId, rawEvent: { writeMode: null } }),
  finished: (runId: string) => frame({ type: "RUN_FINISHED", threadId: THREAD_ID, runId }),
  failed: (message: string) => frame({ type: "RUN_ERROR", message }),
  record: (record: RunState) =>
    frame({ type: "CUSTOM", name: "meridian.run_state", value: record }),
  /** One streamed assistant message, delta by delta. */
  text: (runId: string, ...deltas: string[]): AGUIEvent[] => {
    const messageId = `${runId}::0`;
    return [
      frame({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }),
      ...deltas.map((delta) => frame({ type: "TEXT_MESSAGE_CONTENT", messageId, delta })),
      frame({ type: "TEXT_MESSAGE_END", messageId }),
    ];
  },
  toolCall: (id: string, name: string, args: string, ...results: string[]): AGUIEvent[] => [
    frame({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name }),
    frame({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: args }),
    frame({ type: "TOOL_CALL_END", toolCallId: id }),
    ...results.map((content) => frames.toolResult(id, content)),
  ],
  toolResult: (id: string, content: string) =>
    frame({ type: "TOOL_CALL_RESULT", toolCallId: id, messageId: `${id}-result`, content }),
};

/** Publishes a run-state record at the next journal position, as the server does at a boundary. */
export function publishRecord(wire: Wire, over: Partial<RunState> = {}) {
  wire.publish(frames.record(recordOf({ version: String(wire.head + 1), ...over })));
}

/** The facts of one answered message: what streamed, what the server stored, and how it ended. */
export type ReplySpec = {
  status?: "complete" | "error" | "cancelled";
  /** Text deltas on the stream. Default `["Hello there"]`; none for a failed or cancelled run. */
  streamed?: string[];
  /** The reply's stored text. Default: the streamed text joined. */
  stored?: string;
  error?: string;
  /** Frames between the run's start and its text, such as tool calls. */
  extra?: AGUIEvent[];
  /** Runs after the admission's cursor is taken and before the run's frames: journal the test needs the stream to replay. */
  lead?: () => void;
};

/**
 * Each admission publishes the frames of a run that took the message. The first read after it is
 * taken at the admission's cursor, with the reply still running, so the sync joins below the run's
 * frames and replays them; every later read shows the run's turns as the spec ended them. The nth
 * admission uses the nth spec (the last repeats).
 */
export function replyScenario(wire: Wire, specs: ReplySpec | ReplySpec[]) {
  const list = [specs].flat();
  let n = 0;
  wire.admit = (body) => {
    const spec = list[Math.min(n, list.length - 1)] ?? {};
    n += 1;
    const user = `u${n}`;
    const reply = `a${n}`;
    const status = spec.status ?? "complete";
    const streamed = spec.streamed ?? (status === "complete" ? ["Hello there"] : []);
    const stored = spec.stored ?? streamed.join("");
    const error = status === "error" ? (spec.error ?? "boom") : null;
    const resumeAfterSeq = String(wire.head);
    spec.lead?.();
    wire.publish(frames.started(reply));
    for (const event of spec.extra ?? []) wire.publish(event);
    if (streamed.length) for (const event of frames.text(reply, ...streamed)) wire.publish(event);
    wire.publish(error ? frames.failed(error) : frames.finished(reply));
    const execution = null;
    publishRecord(wire);
    const running = snapshotOf({
      seq: Number(resumeAfterSeq),
      record: { execution: { executionId: `exec-${reply}`, currentTurnId: reply } },
      turns: [
        userTurn(user, 1, body.text, reply),
        replyTurn(reply, 2, { prevTurnId: user, status: "streaming" }),
      ],
    });
    const first = wire.reads + 1;
    wire.snapshot = (read) =>
      read === first
        ? running
        : snapshotOf({
            seq: wire.head,
            record: { execution },
            turns: [
              userTurn(user, 1, body.text, reply),
              replyTurn(reply, 2, {
                prevTurnId: user,
                status,
                error,
                text: stored,
              }),
            ],
          });
    return {
      threadId: THREAD_ID,
      userTurnId: user,
      runStateVersion: null,
      resumeAfterSeq,
      snapshotFloorNextSeq: resumeAfterSeq,
      status: "accepted",
    };
  };
}

/** The records of a `--json` run, one per line. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read fields the envelopes vary on
export const ndjson = (stdout: string): Record<string, any>[] =>
  stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
