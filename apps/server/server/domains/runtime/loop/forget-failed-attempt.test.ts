/**
 * The forgetting rule (design-fx.md F1, C3): which turns leave the conversation when the writer retries a
 * failed reply or the chat moves past it. Each case names the wrong outcome it prevents. `decideForgetting`
 * is pure, so the cases build the facts by hand; the walk over non-closing turns uses the real loader over
 * a fake graph.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Failed-attempt projection and view-row traversal
 */
import type { Block, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { TURN_GRAPH } from "../../threads/ports/turn-graph.js";
import {
  type AppendedTurns,
  type AttemptMember,
  appendedTurns,
  decideForgetting,
  type ForgettingFacts,
  loadForgettingFacts,
} from "./forget-failed-attempt.js";
import { firstClosingRowAfter } from "./latest-row.js";

function block(turnId: string, blockType: Block["blockType"], extra: Partial<Block> = {}): Block {
  return {
    id: `${turnId}-${blockType}-${extra.sequence ?? 0}`,
    turnId,
    responseId: null,
    blockType,
    sequence: 0,
    content: {},
    status: "complete",
    textContent: null,
    createdAt: "2026-10-15T00:00:00.000Z",
    ...extra,
  } as Block;
}

function turn(id: string, role: Turn["role"], extra: Partial<Turn> = {}): Turn {
  return {
    id,
    threadId: "t",
    position: 0,
    role,
    origin: role === "assistant" ? "assistant" : role === "user" ? "writer" : "system",
    status: "complete",
    executionId: null,
    forgottenBy: null,
    blocks: [],
    metadata: null,
    ...extra,
  } as unknown as Turn;
}

const failed = (id: string, extra: Partial<Turn> = {}) =>
  turn(id, "assistant", { status: "error", executionId: "e1", ...extra });
const text = (id: string) => block(id, "text", { textContent: "words", content: "words" });
const member = (value: Turn, delivered: Turn[] = []): AttemptMember => ({ turn: value, delivered });

function facts(
  input: Partial<ForgettingFacts> & Pick<ForgettingFacts, "members">,
): ForgettingFacts {
  return {
    latest: input.members[0]?.turn ?? null,
    failedSeeds: [],
    answered: [],
    summaryProtectedWriterIds: new Set(),
    ...input,
  };
}

const message = turn("u", "user");
const writerNext: AppendedTurns = { closes: true, reservationExecutionId: null, retries: null };
const run = (retries: string | null = null, executionId = "e2"): AppendedTurns => ({
  closes: true,
  reservationExecutionId: executionId,
  retries,
});

describe("decideForgetting", () => {
  it("forgets an empty failure and the message it answered when the chat moves on", () => {
    const f = failed("f");
    expect(
      decideForgetting(facts({ members: [member(f)], answered: [message] }), writerNext),
    ).toEqual({
      forget: ["f", "u"],
      ends: [{ turnId: "f", end: "forgotten" }],
      reason: "forgotten",
    });
  });

  it("forgets nothing when the failure kept text, including a reply cut off at max_tokens", () => {
    const f = failed("f", { blocks: [text("f")], finishReason: "max_tokens" });
    expect(
      decideForgetting(facts({ members: [member(f)], answered: [message] }), writerNext),
    ).toEqual({
      forget: [],
      ends: [{ turnId: "f", end: "moved_on" }],
      reason: null,
    });
  });

  it("forgets nothing when a delivery follows the failure", () => {
    const update = turn("s", "system", { metadata: { kind: "subagent_update" } });
    const decision = decideForgetting(
      facts({ members: [member(failed("f"), [update])], answered: [message] }),
      writerNext,
    );
    expect(decision.forget).toEqual([]);
  });

  it("forgets a failure that only holds an empty reasoning placeholder", () => {
    const f = failed("f", { blocks: [block("f", "reasoning", { content: { text: "" } })] });
    expect(
      decideForgetting(facts({ members: [member(f)], answered: [message] }), writerNext).forget,
    ).toEqual(["f", "u"]);
  });

  it("keeps a failure that made a hidden tool call, although the writer sees no reply", () => {
    const f = failed("f", {
      blocks: [block("f", "tool_use", { content: { toolName: "spawn", toolCallId: "c1" } })],
    });
    expect(
      decideForgetting(facts({ members: [member(f)], answered: [message] }), writerNext),
    ).toEqual({
      forget: [],
      ends: [{ turnId: "f", end: "moved_on" }],
      reason: null,
    });
  });

  it("forgets the failed attempt at a Retry and keeps the message the Retry answers", () => {
    const f = failed("f", { blocks: [text("f")] });
    expect(
      decideForgetting(facts({ members: [member(f)], answered: [message] }), run("f")),
    ).toEqual({
      forget: ["f"],
      ends: [{ turnId: "f", end: "retried" }],
      reason: "retried",
    });
  });

  it("keeps a failed reply with a tool call even when it is retried", () => {
    const f = failed("f", { blocks: [block("f", "tool_use", { content: { toolName: "write" } })] });
    expect(decideForgetting(facts({ members: [member(f)] }), run("f")).forget).toEqual([]);
  });

  it("forgets nothing when a message was admitted while the reply ran (carried)", () => {
    expect(
      decideForgetting(facts({ latest: turn("u2", "user"), members: [] }), writerNext),
    ).toEqual({ forget: [], ends: [], reason: null });
  });

  it("forgets nothing when the same execution continues past a failed compaction", () => {
    const c = turn("c", "compaction", { status: "error", executionId: "e1" });
    const decision = decideForgetting(facts({ members: [member(c)] }), run(null, "e1"));
    expect(decision.forget).toEqual([]);
    expect(decision.ends).toEqual([{ turnId: "c", end: "moved_on" }]);
  });

  it("still sees the continuation when a fresh agent message is adopted before the successor", () => {
    const c = turn("c", "compaction", { status: "error", executionId: "e1" });
    const appended = appendedTurns([
      turn("m", "user", { origin: "system", metadata: { kind: "inbox_message" } }),
      turn("r", "assistant", { executionId: "e1" }),
    ]);
    expect(decideForgetting(facts({ members: [member(c)] }), appended).forget).toEqual([]);
  });

  it("never counts a null execution id as a continuation", () => {
    const f = failed("f", { executionId: null });
    const appended: AppendedTurns = { closes: true, reservationExecutionId: null, retries: null };
    expect(
      decideForgetting(facts({ members: [member(f)], answered: [message] }), appended).forget,
    ).toEqual(["f", "u"]);
  });

  it("forgets an empty Retry and the message after a partial reply was retried", () => {
    const earlier = failed("f", { blocks: [text("f")], forgottenBy: "r" });
    const decision = decideForgetting(
      facts({ members: [member(failed("r")), member(earlier)], answered: [message] }),
      writerNext,
    );
    expect(decision.forget).toEqual(["r", "u"]);
  });

  it("keeps a message a complete compaction summarized without pinning", () => {
    const decision = decideForgetting(
      facts({
        members: [member(failed("f"))],
        answered: [message, turn("u0", "user")],
        summaryProtectedWriterIds: new Set(["u0"]),
      }),
      writerNext,
    );
    expect(decision.forget).toEqual(["f", "u"]);
  });

  it("lists only the newest member of a kept Retry chain as ending now", () => {
    const a = failed("a", { blocks: [block("a", "tool_use")] });
    const b = failed("b", { executionId: "e2" });
    const decision = decideForgetting(facts({ members: [member(b), member(a)] }), run(null, "e3"));
    expect(decision).toEqual({
      forget: [],
      ends: [{ turnId: "b", end: "moved_on" }],
      reason: null,
    });
  });

  const chainFacts = () => {
    const f = failed("f", { forgottenBy: "c" });
    const c = turn("c", "compaction", {
      status: "error",
      executionId: "e1",
      metadata: { retryOf: "f", retryReplyId: "r" },
    });
    const r = failed("r", { executionId: "e1" });
    return facts({ members: [member(r), member(c), member(f)], answered: [message] });
  };

  it("ends only the latest reply when a Retry forgets a continued compaction chain", () => {
    const decision = decideForgetting(chainFacts(), run("r", "e2"));
    expect(decision.forget).toEqual(["r", "c"]);
    expect(decision.ends).toEqual([{ turnId: "r", end: "retried" }]);
  });

  it("ends only the latest reply when the writer moves on from a continued compaction chain", () => {
    const decision = decideForgetting(chainFacts(), writerNext);
    expect(decision.forget).toEqual(["r", "c", "u"]);
    expect(decision.ends).toEqual([{ turnId: "r", end: "forgotten" }]);
  });

  it("ends a failed handoff seed without forgetting it, whatever the latest row is", () => {
    const seed = turn("s", "system", {
      status: "error",
      metadata: { kind: "derivation_seed", derivation: "handoff" },
    });
    expect(
      decideForgetting(facts({ latest: null, members: [], failedSeeds: [seed] }), writerNext),
    ).toEqual({ forget: [], ends: [{ turnId: "s", end: "moved_on" }], reason: null });
  });
});

describe("loadForgettingFacts", () => {
  function chain(turns: Turn[]) {
    const linked = turns.map((held, index) => ({
      ...held,
      position: index + 1,
      prevTurnId: turns[index - 1]?.id ?? null,
    }));
    return {
      [TURN_GRAPH]: {
        listByThread: async () => linked,
        findById: async (id: string) => linked.find((held) => held.id === id) ?? null,
        latest: async () => linked.at(-1) ?? null,
      },
      listMessageDeliveries: async () => new Map([["u", { byTurnId: "f" }]]),
      linked,
    };
  }
  const blocks = { listByTurnIds: async () => [] as Block[] };

  it("reads past a Work refresh to the failed reply, so a closing row still forgets it", async () => {
    const graph = chain([
      turn("u", "user"),
      failed("f"),
      turn("w", "user", {
        origin: "system",
        metadata: { kind: "system_update", section: "work_context" },
      }),
    ]);
    const loaded = await loadForgettingFacts(
      { turns: graph as never, blocks },
      "t" as never,
      "w" as never,
    );
    expect(loaded.latest?.id).toBe("f");
    expect(decideForgetting(loaded, writerNext).forget).toEqual(["f", "u"]);
  });

  it("names the first closing row after a reply, not the latest, when two follow it", async () => {
    const graph = chain([failed("a"), turn("u", "user"), turn("v", "user")]);
    expect((await firstClosingRowAfter(graph as never, "v" as never, "a"))?.id).toBe("u");
    expect(await firstClosingRowAfter(graph as never, "a" as never, "a")).toBeNull();
  });

  const agentMessage = turn("m", "user", { origin: "system", metadata: { kind: "inbox_message" } });
  const report = turn("r", "system", { metadata: { kind: "subagent_update" } });
  const handoffSeed = turn("s", "system", {
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "x",
      cutoffTurnId: "y",
    },
  });
  const childSeed = turn("c", "user", {
    origin: "system",
    metadata: { kind: "inbox_message", agentRequestKind: "child_seed" },
  });
  const reference = block("c", "custom", {
    content: { kind: "thread-reference", props: { threadId: "x" } },
  });
  const walks: Array<[string, Turn[], string[], boolean]> = [
    [
      "an agent message is delivered under the reply alongside its report",
      [agentMessage, report],
      ["m", "r"],
      true,
    ],
    ["a handoff seed is a row, so the walk stops at it", [handoffSeed, report], [], true],
    [
      "a child seed with thread references is a row, so the walk stops at it",
      [childSeed, report],
      [],
      true,
    ],
    ["a child seed without references stays hidden", [childSeed, report], ["r"], false],
  ];
  it.each(walks)(
    "walks deliveries to the view's next row: %s",
    async (_name, after, expected, refs) => {
      const graph = chain([turn("u", "user"), failed("f"), ...after]);
      const loaded = await loadForgettingFacts(
        {
          turns: graph as never,
          blocks: {
            listByTurnIds: async (ids) => (refs && ids.includes("c" as never) ? [reference] : []),
          },
        },
        "t" as never,
        "f" as never,
      );
      expect(loaded.members[0]?.delivered.map((held) => held.id)).toEqual(expected);
    },
  );
});
