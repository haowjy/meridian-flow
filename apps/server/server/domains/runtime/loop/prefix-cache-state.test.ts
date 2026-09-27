import type { ModelResponse, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { derivePrefixCacheState, type PrefixCacheHistory } from "./prefix-cache-state.js";

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
): Pick<ModelResponse, "turnId" | "sequence" | "model" | "createdAt"> {
  return { turnId, sequence: 0, model, createdAt: RESPONSE_AT };
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

describe("derivePrefixCacheState", () => {
  it("predicts warm when the model, prefix, and TTL still match", () => {
    expect(derive()).toEqual({ state: "warm", reason: "reusable_prefix" });
  });

  it("is cold before any model response has warmed a prefix", () => {
    expect(derive({ history: history({ responses: [] }) })).toEqual({
      state: "cold",
      reason: "no_response",
    });
  });

  it("breaks warmth at a prompt-epoch bake boundary", () => {
    const epoch = turn("epoch", 2, {
      role: "system",
      origin: "system",
      promptBakeId: "bake-2" as Turn["promptBakeId"],
      metadata: { kind: "prompt_epoch_boundary", cause: "compaction_undo" },
    });
    expect(derive({ history: history({ turns: [turn("turn-1", 1), epoch] }) })).toEqual({
      state: "cold",
      reason: "prompt_epoch",
    });
  });

  it("recognizes a prompt epoch carried alongside existing typed metadata", () => {
    const epoch = turn("epoch", 2, {
      role: "system",
      origin: "system",
      metadata: {
        kind: "system_update",
        section: "notices",
        promptEpoch: { cause: "compaction" },
      },
    });
    expect(derive({ history: history({ turns: [turn("turn-1", 1), epoch] }) })).toEqual({
      state: "cold",
      reason: "prompt_epoch",
    });
  });

  it("breaks warmth at a named image eviction or asset-loss turn", () => {
    const imageLoss = turn("image-loss", 2, {
      role: "system",
      origin: "system",
      metadata: {
        kind: "system_update",
        section: "image_inclusion",
        breaks: [{ blockId: "image-1", uri: "scratch://image.png", reason: "asset_unavailable" }],
      },
    });
    expect(derive({ history: history({ turns: [turn("turn-1", 1), imageLoss] }) })).toEqual({
      state: "cold",
      reason: "image_eviction",
    });
  });

  it("keeps compaction as a separate named boundary hook", () => {
    const compaction = turn("compaction", 2, { role: "compaction", origin: "system" });
    expect(derive({ history: history({ turns: [turn("turn-1", 1), compaction] }) })).toEqual({
      state: "cold",
      reason: "compaction",
    });
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

  it("can reuse the source prefix for a fork cut at its latest turn with the same bake", () => {
    const forkHistory = history({
      thread: {
        id: "fork-1",
        initialPromptBakeId: "bake-1" as Thread["initialPromptBakeId"],
        originType: "fork",
        originTurnId: "source-turn-1",
      },
      turns: [turn("fork-local", 2, { threadId: "fork-1" })],
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
