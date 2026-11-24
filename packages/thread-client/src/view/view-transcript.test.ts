/** Guards the view model's seams: row identity versus render key, stand-in placement, queued writer rows, and which turns draw as items.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Transcript row identity, failure placement, and interning
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { viewAssistantTurn } from "./assistant-view";
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
    origin: role === "user" ? "writer" : role === "assistant" ? "assistant" : "system",
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
  expect(view.rows.map((row) => row.identity.turnId)).toEqual([null, "u1", "a1", "c1", null, null]);
  expect(view.rows.map((row) => row.queued)).toEqual([false, false, false, false, false, true]);
  expect([...view.writer.keys()]).toEqual(["u1", local]);
  expect(view.items.get("a1")?.items.map((item) => item.kind)).toEqual(["text"]);
  expect(view.rows[3]?.response?.parts.map((part) => part.id)).toEqual(["c1"]);
});

const ids = (view: ReturnType<typeof viewTranscript>) => view.rows.map((row) => row.turn.id);

it("draws a pending Retry in the failed reply's place, even with a message sent after it", () => {
  const failed = turn("f", "assistant", "u1", { status: "error" });
  const base = [turn("u1", "user", null), failed, turn("u2", "user", "f")];
  const standIn = turn("r1", "assistant", "f", {
    status: "pending",
    blocks: [],
    metadata: { retryOf: "f" },
  });
  const pending = viewTranscript({
    turns: base,
    standIns: [standIn],
    activity: { awaitingSubagents: false },
  });
  expect(ids(pending)).toEqual(["u1", "r1", "u2"]);
  const slot = (switchAwaitsRun: boolean) =>
    viewTranscript({
      turns: base,
      standIns: [standIn],
      switchAwaitsRun,
      activity: { awaitingSubagents: false },
    }).controlSlot;
  expect([slot(true), slot(false)]).toEqual([1, 3]);
  const lost = turn("r0", "assistant", "f", {
    status: "pending",
    blocks: [],
    metadata: { retryOf: "f" },
  });
  const later = [...base, turn("f2", "assistant", "u2", { status: "error" })];
  const slotAmong = (standIns: Turn[]) =>
    viewTranscript({
      turns: later,
      standIns,
      switchAwaitsRun: true,
      activity: { awaitingSubagents: false },
    }).controlSlot;
  const next = turn("r2", "assistant", "f2", {
    status: "pending",
    blocks: [],
    metadata: { retryOf: "f2" },
  });
  expect(slotAmong([lost])).toBe(4);
  expect(slotAmong([lost, next])).toBe(3);
  expect(ids(viewTranscript({ turns: base, activity: { awaitingSubagents: false } }))).toEqual([
    "u1",
    "f",
    "u2",
  ]);
  expect(
    ids(
      viewTranscript({
        turns: [...base, turn("r1", "assistant", "u2", { status: "streaming" })],
        retried: new Set(["f"]),
        activity: { awaitingSubagents: false },
      }),
    ),
  ).toEqual(["u1", "u2", "r1"]);
});

it("draws one failure for a chain of failed retries, the newest, and none for a past failure", () => {
  const view = viewTranscript({
    turns: [
      turn("u1", "user", null),
      turn("f", "assistant", "u1", { status: "error" }),
      turn("c1", "compaction", "f", { metadata: { retryOf: "f" } }),
      turn("r1", "assistant", "c1", { status: "error" }),
      turn("r2", "assistant", "r1", { status: "error", metadata: { retryOf: "r1" } }),
    ],
    activity: { awaitingSubagents: false },
  });
  expect(view.rows.filter((row) => row.turn.status === "error").map((row) => row.turn.id)).toEqual([
    "r2",
  ]);
  expect(ids(view)).toEqual(["u1", "c1", "r2"]);
  const emptyFailed = turn("f", "assistant", "u1", { status: "error", blocks: [] });
  const partial = turn("p", "assistant", "u2", { status: "error" });
  const turns = [
    turn("u1", "user", null),
    emptyFailed,
    turn("u2", "user", "f"),
    partial,
    turn("u3", "user", "p"),
    turn("a3", "assistant", "u3"),
  ];
  const rowsOf = (refused?: ReadonlySet<string>) =>
    ids(
      viewTranscript({ turns, anchoredTurnIds: refused, activity: { awaitingSubagents: false } }),
    );
  expect(rowsOf()).toEqual(["u1", "u2", "p", "u3", "a3"]);
  expect(rowsOf(new Set(["f"]))).toEqual(["u1", "f", "u2", "p", "u3", "a3"]);
  expect(
    ids(viewTranscript({ turns: turns.slice(0, 2), activity: { awaitingSubagents: false } })),
  ).toEqual(["u1", "f"]);

  const forgotten = turns.map((held) =>
    held.id === "u1" || held.id === "f" ? { ...held, forgottenBy: "u2" } : held,
  );
  const rowsAmong = (refused?: ReadonlySet<string>) =>
    ids(
      viewTranscript({
        turns: forgotten,
        anchoredTurnIds: refused,
        activity: { awaitingSubagents: false },
      }),
    );
  expect(rowsAmong()).toEqual(["u2", "p", "u3", "a3"]);
  expect(rowsAmong(new Set(["f"]))).toEqual(["f", "u2", "p", "u3", "a3"]);
  const competing = turn("r2", "assistant", "f", { status: "error", metadata: { retryOf: "f" } });
  const raced = viewTranscript({
    turns: [turn("u1", "user", null), { ...emptyFailed, forgottenBy: "r2" }, competing],
    anchoredTurnIds: new Set(["f"]),
    activity: { awaitingSubagents: false },
  });
  expect(ids(raced)).toEqual(["u1", "f", "r2"]);
  const inheritedRows = viewTranscript({
    turns: [turn("l1", "user", "a3")],
    inherited: {
      turns: [forgotten[0] as Turn, { ...partial, forgottenBy: "beyond-the-cutoff" }],
      ownerByTurnId: new Map([
        ["u1", "src"],
        ["p", "src"],
      ]),
    },
    activity: { awaitingSubagents: false },
  });
  expect(ids(inheritedRows)).toEqual(["u1", "p", "l1"]);

  const failedCompaction = turn("c", "compaction", "u1", { status: "error", blocks: [] });
  const continued = viewTranscript({
    turns: [turn("u1", "user", null), failedCompaction, turn("r", "assistant", "c")],
    activity: { awaitingSubagents: false },
  });
  expect(ids(continued)).toEqual(["u1", "r"]);
  const optimistic = viewTranscript({
    turns: [
      turn("u1", "user", null),
      emptyFailed,
      turn(`${OPTIMISTIC_TURN_ID_PREFIX}9`, "user", "f"),
    ],
    activity: { awaitingSubagents: false },
  });
  expect(ids(optimistic)).toEqual(["u1", `${OPTIMISTIC_TURN_ID_PREFIX}9`]);

  const seed = turn("s", "system", null, {
    status: "error",
    blocks: [],
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "x",
      cutoffTurnId: "y",
    },
  });
  const seedLatest = (more: Turn[]) =>
    viewTranscript({ turns: [seed, ...more], activity: { awaitingSubagents: false } }).rows.find(
      (row) => row.kind === "handoff-seed",
    );
  expect(seedLatest([])).toMatchObject({ latest: true });
  expect(seedLatest([turn("w", "user", "s")])).toMatchObject({ latest: false });
  const agentMessage = turn("m", "user", "s", {
    origin: "system",
    metadata: { kind: "inbox_message" },
  });
  expect(seedLatest([agentMessage])).toMatchObject({ latest: false });

  const afterAgent = (reply: Turn) =>
    viewTranscript({
      turns: [turn("u", "user", null), reply, { ...agentMessage, prevTurnId: reply.id }],
      activity: { awaitingSubagents: false },
    });
  expect(afterAgent(turn("k", "assistant", "u", { status: "error" })).rows[1]).toMatchObject({
    turn: { id: "k" },
    movedPast: true,
  });
  const empty = afterAgent(turn("e", "assistant", "u", { status: "error", blocks: [] }));
  expect(ids(empty)).toEqual(["u", "e"]);
  expect(empty.rows[1]?.deliveries[0]?.events[0]?.message).toBe("m words");
});

it("leaves a handed-back message out and keeps history and later sends", () => {
  const view = viewTranscript({
    turns: [
      turn("m1", "user", null),
      turn("a1", "assistant", "m1"),
      turn("m2", "user", "a1"),
      turn("m3", "user", "m2"),
    ],
    hidden: new Set(["m2"]),
    activity: { awaitingSubagents: false },
  });
  expect(ids(view)).toEqual(["m1", "a1", "m3"]);
});

it("interns settled rows and items when an unrelated live tail changes", () => {
  const writer = turn("u1", "user", null);
  const settled = turn("a1", "assistant", "u1");
  const nextWriter = turn("u2", "user", "a1");
  const live = turn("a2", "assistant", "u2", { status: "streaming" });
  const settledView = viewAssistantTurn(settled);
  const first = viewTranscript({
    turns: [writer, settled, nextWriter, live],
    activity: { awaitingSubagents: false },
  });
  const changedLive = {
    ...live,
    blocks: [{ ...live.blocks[0], textContent: "a longer live tail" } as Block],
  };
  const second = viewTranscript({
    turns: [writer, settled, nextWriter, changedLive],
    activity: { awaitingSubagents: false },
  });

  expect(first.rows[1]).toBe(second.rows[1]);
  expect(first.items.get("a1")).toBe(settledView);
  expect(second.items.get("a1")).toBe(settledView);
  expect(first.items.get("a1")?.items[0]).toBe(second.items.get("a1")?.items[0]);
  expect(first.rows.at(-1)).not.toBe(second.rows.at(-1));
});

it("keeps delivery-group identity across tail growth but refreshes invocation-derived titles", () => {
  const invocation = (title: string): Block => ({
    ...turn("a1", "assistant", null).blocks[0],
    id: "card",
    blockType: "custom",
    content: {
      kind: "helper-result",
      props: {
        agentSlug: "critic",
        agentName: "Critic",
        parentTurnId: "a1",
        toolCallId: "call-1",
        childThreadId: "child-1",
        deliveryMode: "background_notification",
        execution: "execution-1",
        startedAt: "2026-10-13T00:00:00.000Z",
        terminalAt: null,
        title,
      },
    },
  });
  const reply = turn("a1", "assistant", null, { blocks: [invocation("First title")] });
  const completion = turn("d1", "system", "a1", {
    blocks: [],
    metadata: {
      kind: "subagent_update",
      handle: "p1",
      execution: "execution-1",
      outcome: "succeeded",
      childThreadId: "child-1",
      agentName: "Critic",
    },
  });
  const writer = turn("u2", "user", "d1");
  const tail = turn("a2", "assistant", "u2", { status: "streaming" });
  const first = viewTranscript({
    turns: [reply, completion, writer, tail],
    activity: { awaitingSubagents: false },
  });
  const grown = viewTranscript({
    turns: [
      reply,
      completion,
      writer,
      { ...tail, blocks: [{ ...tail.blocks[0], textContent: "grown" } as Block] },
    ],
    activity: { awaitingSubagents: false },
  });
  expect(first.rows[0]).toBe(grown.rows[0]);
  expect(first.rows[0]?.deliveries).toBe(grown.rows[0]?.deliveries);
  expect(first.rows[0]?.deliveries[0]?.id).toBe("d1");

  const renamed = viewTranscript({
    turns: [{ ...reply, blocks: [invocation("Changed title")] }, completion, writer, tail],
    activity: { awaitingSubagents: false },
  });
  expect(renamed.rows[0]).not.toBe(first.rows[0]);
  expect(renamed.rows[0]?.deliveries[0]?.events[0]?.title).toBe("Changed title");

  const leadingMessage = turn("m1", "user", null, {
    origin: "system",
    metadata: {
      kind: "inbox_message",
      agentRequestKind: "foreground_message",
      sender: { threadId: "sender-1", ref: "c1", title: "Planning" },
    },
  });
  const leading = viewTranscript({
    turns: [leadingMessage, turn("a3", "assistant", "m1")],
    activity: { awaitingSubagents: false },
  });
  expect(leading.rows[0]).toMatchObject({
    kind: "delivery",
    deliveries: [
      {
        events: [
          {
            message: "m1 words",
            sender: { threadId: "sender-1", ref: "c1", title: "Planning" },
          },
        ],
      },
    ],
  });
  const groupedMessage = { ...leadingMessage, prevTurnId: reply.id };
  const grouped = viewTranscript({
    turns: [reply, groupedMessage, turn("a4", "assistant", "m1")],
    activity: { awaitingSubagents: false },
  });
  expect(grouped.rows.map((row) => row.kind)).toEqual(["turn", "turn"]);
  expect(grouped.rows[0]?.deliveries[0]?.events[0]).toMatchObject({
    message: "m1 words",
    sender: { threadId: "sender-1", ref: "c1", title: "Planning" },
  });

  const compact = turn("compact", "compaction", reply.id, { blocks: [] });
  const unattributedForeground = turn("m2", "user", compact.id, {
    origin: "system",
    metadata: { kind: "inbox_message", agentRequestKind: "foreground_message" },
  });
  const childSeed = turn("seed", "user", unattributedForeground.id, {
    origin: "system",
    metadata: { kind: "inbox_message", agentRequestKind: "child_seed" },
  });
  const afterCompaction = viewTranscript({
    turns: [reply, compact, unattributedForeground, childSeed],
    activity: { awaitingSubagents: false },
  });
  expect(afterCompaction.rows.map((row) => [row.kind, row.turn.id])).toEqual([
    ["turn", "a1"],
    ["compaction", "compact"],
    ["delivery", "m2"],
  ]);
});
