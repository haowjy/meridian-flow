/** chatCards: the one decision about which chat failure the writer sees, and where. */
import type { Block, Turn } from "@meridian/contracts/protocol";
import type { PendingInboxItem, RunState } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import { INITIAL_RUN_STATE_VIEW, receiveRecord } from "../run-state/run-state-view";
import { type ChatCardsInput, chatCards } from "./chat-cards";

function turn(
  id: string,
  role: Turn["role"],
  prev: string | null,
  extra: Partial<Turn> = {},
): Turn {
  const text = {
    id: `${id}-t`,
    blockType: "text",
    sequence: 0,
    textContent: id,
  } as unknown as Block;
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
    error: null,
    ...extra,
  } as unknown as Turn;
}

const record = (extra: Partial<RunState> = {}, items: PendingInboxItem[] = []): RunState => ({
  version: "5",
  items,
  sentThrough: 0,
  execution: null,
  mode: "direct",
  blocked: null,
  ...extra,
});

const base = (over: Partial<ChatCardsInput> = {}): ChatCardsInput => ({
  threadId: "t",
  turns: { turns: [] },
  runState: INITIAL_RUN_STATE_VIEW,
  handBack: [],
  retries: [],
  briefStops: [],
  controls: [],
  ...over,
});

const failed = (id: string, prev: string | null, extra: Partial<Turn> = {}) =>
  turn(id, "assistant", prev, { status: "error", error: "boom", ...extra });

it("shows a failed reply's card only while it is the latest row, and a Retry replaces it", () => {
  // Risk: the card outliving the writer's chance to act (the old split between the view and the block).
  const u1 = turn("u1", "user", null);
  const f = failed("f", "u1");
  const cardsOf = (turns: Turn[], retried?: Set<string>) =>
    chatCards(base({ turns: { turns, retried } })).cards.map((c) => [c.key, c.copy, c.action]);
  expect(cardsOf([u1, f])).toEqual([["f", "reply-failed", "retry"]]);
  expect(cardsOf([u1, f, turn("u2", "user", "f")])).toEqual([]);
  expect(cardsOf([u1, f], new Set(["f"]))).toEqual([]);
  expect(
    cardsOf([
      u1,
      failed("p", "u1", {
        metadata: { retryable: false, providerError: { status: 404, message: "m" } },
      }),
    ]),
  ).toEqual([["p", "reply-declined", "retry"]]);
});

it("anchors a refused Retry on its reply for the view even when the reply was forgotten, and a lost one on the reply itself", () => {
  // Risk: a refusal card with no row to sit on, and a lost Retry posing as a failed reply.
  const u1 = turn("u1", "user", null);
  const f = failed("f", "u1", { forgottenBy: "r2" });
  const refused = chatCards(
    base({
      turns: { turns: [u1, f] },
      retries: [
        { kind: "refused", turnId: "f", requestId: "req", attempt: 1, cause: "another-reply" },
      ],
    }),
  );
  expect(refused.cards).toMatchObject([
    { key: "req:1", copy: "retry-refused-another-reply", anchor: { turn: "f" }, action: null },
  ]);
  expect([...refused.anchoredTurnIds]).toEqual(["f"]);

  const live = failed("f", "u1");
  const lost = chatCards(
    base({
      turns: { turns: [u1, live] },
      retries: [{ kind: "lost", turnId: "f", requestId: "req", attempt: 2 }],
    }),
  );
  expect(lost.cards.map((c) => [c.key, c.copy, c.action])).toEqual([
    ["f", "reply-failed", "retry"],
    ["req:2", "retry-lost", "try_again"],
  ]);
  // The chat moved past the reply: nothing left to retry.
  const past = chatCards(
    base({
      turns: { turns: [u1, live, turn("u2", "user", "f")] },
      retries: [{ kind: "lost", turnId: "f", requestId: "req", attempt: 2 }],
    }),
  );
  expect(past.cards).toEqual([]);
});

it("cards a manual compaction's failure with Try again, never an autocompaction's, and none once a /compact is queued", () => {
  // Risk: a bare red line with no action (the old divider), or a Try again that queues a second compaction.
  const u1 = turn("u1", "user", null);
  const compaction = (trigger: "manual" | "auto") =>
    turn("c", "compaction", "u1", {
      status: "error",
      error: "Couldn't compact.",
      metadata: { kind: "compaction", trigger },
    });
  const cards = (trigger: "manual" | "auto", controls: ChatCardsInput["controls"] = []) =>
    chatCards(base({ turns: { turns: [u1, compaction(trigger)] }, controls })).cards;
  expect(cards("manual")).toMatchObject([
    { key: "c", copy: "compaction-failed", action: "try_again", text: "Couldn't compact." },
  ]);
  expect(cards("auto")).toEqual([]);
  expect(
    cards("manual", [{ id: "q", control: { kind: "compact" }, status: "withdraw_failed" }]),
  ).toMatchObject([{ copy: "compact-withdraw-failed", action: "try_again" }]);
  expect(cards("manual", [{ id: "q", control: { kind: "compact" }, status: "queued" }])).toEqual(
    [],
  );
});

it("stacks usage before commands, keeps a writer's unsent words, and anchors a queued command's failures on its row", () => {
  // Risk: the composer stack's order, and the writer's words or a queued row losing their card.
  const blocked = receiveRecord(
    INITIAL_RUN_STATE_VIEW,
    record({ blocked: { reason: "credits_exhausted" } }, [
      {
        id: "m",
        seq: 7,
        intent: "message",
        provenance: { kind: "writer", actorId: "w" },
        deliveryState: "awaiting_run",
        summary: "m",
        enqueuedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
  );
  const result = chatCards(
    base({
      runState: blocked,
      turns: {
        turns: [
          turn("u1", "user", null, { status: "error" }),
          turn("u2", "user", "u1", { status: "error" }),
        ],
      },
      movingTurnIds: new Set(["u2"]),
      handBack: [
        {
          requestId: "h",
          commandKind: "queue",
          status: "ambiguous",
          count: 1,
          targetExecutionId: null,
          attempt: 3,
        },
      ],
      controls: [
        { id: "k1", control: { kind: "compact" }, status: "failed" },
        { id: "k2", control: { kind: "write_mode", mode: "draft" }, status: "withdraw_failed" },
      ],
    }),
  );
  expect(result.cards.map((c) => [c.key, c.copy, JSON.stringify(c.anchor)])).toEqual([
    ["usage:t:7", "usage-blocked", '"composer"'],
    ["h:3", "hand-back-failed", '"composer"'],
    ["u1:1", "send-failed", '{"message":"u1"}'],
    ["k1:1", "compact-enqueue-failed", '{"queuedControl":"k1"}'],
    ["withdraw:k2:1", "switch-withdraw-failed", '{"queuedControl":"k2"}'],
  ]);
});
