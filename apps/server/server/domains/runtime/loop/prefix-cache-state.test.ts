import type { ModelResponse, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { bakeIdAt, findCutoffOwnerThreadId } from "../../threads/index.js";
import { encodeImageInclusionMetadata } from "./image-context.js";
import {
  createPrefixCacheStateService,
  derivePrefixCacheState,
  type PrefixCacheHistory,
} from "./prefix-cache-state.js";

const TTL_MS = 60_000;
const NOW_MS = Date.parse("2026-09-27T12:00:00.000Z");
const RESPONSE_AT = "2026-09-27T11:59:30.000Z";
const MODEL = "writer-model";
const CACHE = { kind: "automatic", ttlMs: TTL_MS } as const;

function turn(id: string, position: number, values: Partial<Turn> = {}): Turn {
  return {
    id,
    threadId: "thread-1",
    position,
    prevTurnId: null,
    parentTurnId: null,
    role: "user",
    origin: "writer",
    writeMode: null,
    status: "complete",
    promptBakeId: null,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    createdAt: "2026-09-27T11:59:00.000Z",
    completedAt: "2026-09-27T11:59:00.000Z",
    blocks: [],
    siblingIds: [],
    responses: [],
    ...values,
  };
}

function response(
  turnId: string,
  model = MODEL,
  sequence = 0,
): Pick<ModelResponse, "turnId" | "sequence" | "model" | "requestStartedAt"> {
  return { turnId, sequence, model, requestStartedAt: RESPONSE_AT };
}

function history(values: Partial<PrefixCacheHistory> = {}): PrefixCacheHistory {
  const thread: PrefixCacheHistory["thread"] = {
    id: "thread-1",
    initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
    originType: null,
    originTurnId: null,
  };
  return {
    thread,
    turns: [turn("turn-1", 1)],
    responses: [response("turn-1")],
    ...values,
  };
}

function derive(input: Partial<Parameters<typeof derivePrefixCacheState>[0]> = {}) {
  return derivePrefixCacheState({
    model: MODEL,
    promptCache: CACHE,
    nowMs: NOW_MS,
    history: history(),
    ...input,
  });
}

function imageNotice(
  reason: "asset_unavailable" | "asset_unavailable_first_sight" | "budget_eviction",
) {
  return turn(`image-${reason}`, 2, {
    role: "system",
    origin: "system",
    metadata: encodeImageInclusionMetadata([
      { blockId: "image-1", uri: "scratch://image.png", reason },
    ]),
  });
}

describe("derivePrefixCacheState", () => {
  it("predicts warm when the model, prefix, and TTL still match", () => {
    expect(derive()).toEqual({ state: "warm", reason: "reusable_prefix" });
  });

  it("gathers the current thread's facts through the runtime service", async () => {
    const threadHistory = history();
    const latest = response("turn-1");
    const { prefixCacheStateFor } = createPrefixCacheStateService({
      repos: {
        threads: {
          async findByIdIncludingDeleted() {
            return threadHistory.thread as Thread;
          },
        },
        turns: {
          async findById() {
            return null;
          },
          async listByThread() {
            return [...threadHistory.turns];
          },
        },
        modelResponses: {
          async findLatestByThread() {
            return latest;
          },
        },
      },
    });

    await expect(
      prefixCacheStateFor({
        threadId: "thread-1" as Thread["id"],
        model: {
          id: MODEL,
          provider: "test-provider",
          displayName: "Writer model",
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          promptCache: CACHE,
          capabilities: new Set(),
        },
        now: NOW_MS,
      }),
    ).resolves.toEqual({ state: "warm", reason: "reusable_prefix" });
  });

  it("uses known local turns without another thread-history read", async () => {
    const threadHistory = history();
    let turnReads = 0;
    const { prefixCacheStateFor } = createPrefixCacheStateService({
      repos: {
        threads: {
          async findByIdIncludingDeleted() {
            return threadHistory.thread as Thread;
          },
        },
        turns: {
          async findById() {
            return null;
          },
          async listByThread() {
            turnReads += 1;
            return [];
          },
        },
        modelResponses: {
          async findLatestByThread() {
            return response("turn-1");
          },
        },
      },
    });

    await expect(
      prefixCacheStateFor({
        threadId: "thread-1" as Thread["id"],
        model: {
          id: MODEL,
          provider: "test-provider",
          displayName: "Writer model",
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          promptCache: CACHE,
          capabilities: new Set(),
        },
        now: NOW_MS,
        knownLocalTurns: threadHistory.turns,
      }),
    ).resolves.toEqual({ state: "warm", reason: "reusable_prefix" });
    expect(turnReads).toBe(0);
  });

  it("is cold before any model response has warmed a prefix", () => {
    expect(derive({ history: history({ responses: [] }) })).toEqual({
      state: "cold",
      reason: "no_response",
    });
  });

  it("detects a bake change without relying on display metadata", () => {
    const epoch = turn("epoch", 2, {
      role: "system",
      origin: "system",
      promptBakeId: "bake-2" as Turn["promptBakeId"],
      metadata: null,
    });
    expect(derive({ history: history({ turns: [turn("turn-1", 1), epoch] }) })).toEqual({
      state: "cold",
      reason: "prompt_epoch",
    });
  });

  it("reports a compaction before a model change", () => {
    const compaction = turn("compaction", 2, {
      role: "compaction",
      origin: "system",
    });
    expect(
      derive({
        model: "summarizer-model",
        history: history({ turns: [turn("turn-1", 1), compaction] }),
      }),
    ).toEqual({ state: "cold", reason: "compaction" });
  });

  it("uses beginPromptEpoch-shaped turns for the shared bake rule", () => {
    const boundary = turn("epoch", 2, {
      role: "system",
      origin: "system",
      promptBakeId: "bake-2" as Turn["promptBakeId"],
      metadata: { promptEpoch: { cause: "compaction" } },
    });
    expect(bakeIdAt([boundary, turn("turn-1", 1)], "epoch", "bake-1")).toBe("bake-2");
  });

  it("breaks the prefix for eviction and loss of an already-sent image", () => {
    for (const reason of ["budget_eviction", "asset_unavailable"] as const) {
      expect(
        derive({ history: history({ turns: [turn("turn-1", 1), imageNotice(reason)] }) }),
      ).toEqual({
        state: "cold",
        reason: "image_eviction",
      });
    }
  });

  it("keeps a never-sent first-sight image notice warm", () => {
    expect(
      derive({
        history: history({
          turns: [turn("turn-1", 1), imageNotice("asset_unavailable_first_sight")],
        }),
      }),
    ).toEqual({ state: "warm", reason: "reusable_prefix" });
  });

  it("does not let an unsettled compaction placeholder break warmth", () => {
    for (const status of ["pending", "error", "cancelled"] as const) {
      const compaction = turn("compaction", 2, {
        role: "compaction",
        origin: "system",
        status,
        completedAt: null,
      });
      expect(derive({ history: history({ turns: [turn("turn-1", 1), compaction] }) })).toEqual({
        state: "warm",
        reason: "reusable_prefix",
      });
    }
  });

  it("treats a response on a completed compaction boundary as cold, then warms again", () => {
    const compaction = turn("compaction", 2, {
      role: "compaction",
      origin: "system",
      promptBakeId: "bake-2" as Turn["promptBakeId"],
    });
    expect(
      derive({
        history: history({
          turns: [turn("turn-1", 1), compaction],
          responses: [response("compaction")],
        }),
      }),
    ).toEqual({ state: "cold", reason: "compaction" });

    const nextTurn = turn("turn-3", 3, { role: "assistant", origin: "assistant" });
    expect(
      derive({
        history: history({
          turns: [turn("turn-1", 1), compaction, nextTurn],
          responses: [response("turn-3")],
        }),
      }),
    ).toEqual({ state: "warm", reason: "reusable_prefix" });
  });

  it("clamps a negative age to zero and classifies invalid timestamps as unavailable", () => {
    expect(derive({ nowMs: Date.parse(RESPONSE_AT) - 1 })).toEqual({
      state: "warm",
      reason: "reusable_prefix",
    });
    expect(
      derive({
        history: history({ responses: [{ ...response("turn-1"), requestStartedAt: "invalid" }] }),
      }),
    ).toEqual({ state: "cold", reason: "facts_unavailable" });
  });

  it("expires from request start even when the response was just persisted", () => {
    expect(
      derive({
        history: history({
          responses: [{ ...response("turn-1"), requestStartedAt: "2026-09-27T11:58:00.000Z" }],
        }),
      }),
    ).toEqual({ state: "cold", reason: "ttl_expired" });
  });

  it("expires at the descriptor TTL", () => {
    expect(derive({ nowMs: Date.parse(RESPONSE_AT) + TTL_MS })).toEqual({
      state: "cold",
      reason: "ttl_expired",
    });
  });

  it("is cold after a model change", () => {
    expect(
      derive({ history: history({ responses: [response("turn-1", "other-model")] }) }),
    ).toEqual({ state: "cold", reason: "model_changed" });
  });

  it("is cold when a fork cutoff predates the cutoff owner's latest turn", () => {
    const forkHistory = history({
      thread: {
        id: "fork-1",
        initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
        originType: "fork",
        originTurnId: "source-turn-1",
      },
      turns: [turn("fork-local", 3, { threadId: "fork-1" })],
      responses: [],
    });
    const sourceHistory: PrefixCacheHistory = {
      thread: {
        id: "source-1",
        initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
        originType: null,
        originTurnId: null,
      },
      turns: [
        turn("source-turn-1", 1, { threadId: "source-1" }),
        turn("source-turn-2", 2, { threadId: "source-1" }),
      ],
      responses: [response("source-turn-2")],
    };

    expect(derive({ history: forkHistory, forkOwner: sourceHistory })).toEqual({
      state: "cold",
      reason: "fork_cutoff",
    });
  });

  it("routes and predicts warmth from the grandsource for a fork cut at an inherited turn", async () => {
    const inheritedTurn = turn("grand-turn", 1, { threadId: "grand-source" });
    const forkHistory = history({
      thread: {
        id: "nested-fork",
        initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
        originType: "fork",
        originTurnId: "grand-turn",
      },
      turns: [turn("fork-local", 2, { threadId: "nested-fork" })],
      responses: [],
    });
    const grandSource: PrefixCacheHistory = {
      thread: {
        id: "grand-source",
        initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
        originType: null,
        originTurnId: null,
      },
      turns: [inheritedTurn],
      responses: [response("grand-turn")],
    };

    expect(
      await findCutoffOwnerThreadId(forkHistory.thread as Thread, async (id) =>
        id === inheritedTurn.id ? inheritedTurn : null,
      ),
    ).toBe("grand-source");
    expect(derive({ history: forkHistory, forkOwner: grandSource })).toEqual({
      state: "warm",
      reason: "reusable_prefix",
    });
  });

  it("breaks a latest fork cutoff when its bake differs from the owner bake", () => {
    const forkHistory = history({
      thread: {
        id: "fork-1",
        initialPromptBakeId: "bake-fork" as Thread["initialPromptBakeId"],
        originType: "fork",
        originTurnId: "source-turn-1",
      },
      turns: [],
      responses: [],
    });
    const sourceHistory: PrefixCacheHistory = {
      thread: {
        id: "source-1",
        initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
        originType: null,
        originTurnId: null,
      },
      turns: [turn("source-turn-1", 1, { threadId: "source-1" })],
      responses: [response("source-turn-1")],
    };

    expect(derive({ history: forkHistory, forkOwner: sourceHistory })).toEqual({
      state: "cold",
      reason: "fork_bake_changed",
    });
  });

  it("is cold for an uncached model regardless of stored history", () => {
    expect(derive({ promptCache: { kind: "none", ttlMs: null } })).toEqual({
      state: "cold",
      reason: "uncached",
    });
  });
});
