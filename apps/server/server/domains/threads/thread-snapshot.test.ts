/**
 * Thread snapshot tests: verify initial client-load projections such as waiting state
 * and client-safe block content. These tests protect the snapshot boundary without
 * weakening the internal thread repositories that runtime replay consumes.
 */

import type { Block, JsonObject } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../observability/index.js";
import { createInMemoryEventJournalReader } from "./adapters/in-memory/event-reader.js";
import { createInMemoryEventJournalWriter } from "./adapters/in-memory/event-writer.js";
import { createInMemoryRepositories } from "./adapters/in-memory/repositories.js";
import type { ThreadEventHub } from "./thread-event-hub.js";
import { createThreadEventHub } from "./thread-event-hub.js";
import { buildThreadSnapshot, toClientSafeBlock } from "./thread-snapshot.js";

const emptyHub: ThreadEventHub = {
  publishPersistedEvent: () => {},
  appendEvent: async () => {
    throw new Error("appendEvent is not used by thread snapshot tests");
  },
  catchup: async () => [],
  subscribe: () => () => {},
  catchupAndSubscribe: async () => ({ catchup: [], hitReplayLimit: false, unsubscribe: () => {} }),
  hasThreadState: () => false,
  headSeq: async () => 0n,
  readModelProjectionWatermark: async () => 0n,
  journalSeqForEventSeq: (seq) => seq,
};
const idleRunner = { getRunningTurnId: () => null };

function contentObject(block: Block): JsonObject {
  if (typeof block.content !== "object" || block.content === null || Array.isArray(block.content)) {
    throw new Error(`Expected object content for block ${block.id}`);
  }
  return block.content;
}

function hubForJournal(
  writer: ReturnType<typeof createInMemoryEventJournalWriter>,
): ThreadEventHub {
  return createThreadEventHub({
    journalWriter: writer,
    journalReader: createInMemoryEventJournalReader(writer),
    eventSink: createInMemoryEventSink(),
  });
}

describe("toClientSafeBlock", () => {
  it("only strips provider replay metadata from reasoning/thinking block content", () => {
    const baseBlock: Block = {
      id: "block-1",
      turnId: "turn-1",
      responseId: null,
      blockType: "reasoning",
      sequence: 0,
      textContent: "visible reasoning",
      content: {
        text: "visible reasoning",
        summary: "visible summary",
        providerOptions: { anthropic: { signature: "sig-secret" } },
      },
      createdAt: "2026-06-07T00:00:00.000Z",
    };

    const projected = toClientSafeBlock(baseBlock);

    expect(projected).not.toBe(baseBlock);
    expect(projected.textContent).toBe("visible reasoning");
    expect(projected.content).toEqual({
      text: "visible reasoning",
      summary: "visible summary",
    });
    expect(contentObject(baseBlock).providerOptions).toEqual({
      anthropic: { signature: "sig-secret" },
    });

    const textBlock: Block = {
      ...baseBlock,
      id: "text-block",
      blockType: "text",
      content: { text: "hello", providerOptions: { shouldRemain: true } },
    };
    expect(toClientSafeBlock(textBlock)).toBe(textBlock);
  });
});

describe("buildThreadSnapshot", () => {
  it("projects unread from an unopened complete assistant head", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const userTurn = await repos.turns.create({
      threadId: thread.id,
      role: "user",
      status: "complete",
    });
    await repos.turns.create({
      threadId: thread.id,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "complete",
    });

    await expect(
      buildThreadSnapshot(repos, emptyHub, idleRunner, thread.id, "user-1"),
    ).resolves.toMatchObject({ attention: "unread" });
  });

  it("does not advertise runner liveness for a terminal durable turn", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const userTurn = await repos.turns.create({
      threadId: thread.id,
      role: "user",
      status: "complete",
    });
    const assistantTurn = await repos.turns.create({
      threadId: thread.id,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "error",
    });

    const snapshot = await buildThreadSnapshot(
      repos,
      emptyHub,
      { getRunningTurnId: () => assistantTurn.id },
      thread.id,
      "user-1",
    );

    expect(snapshot.liveState.runningTurnId).toBeNull();
  });

  it("advertises runner liveness for a present non-terminal durable turn", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const userTurn = await repos.turns.create({
      threadId: thread.id,
      role: "user",
      status: "complete",
    });
    const assistantTurn = await repos.turns.create({
      threadId: thread.id,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "streaming",
    });

    const snapshot = await buildThreadSnapshot(
      repos,
      emptyHub,
      { getRunningTurnId: () => assistantTurn.id },
      thread.id,
      "user-1",
    );

    expect(snapshot.liveState.runningTurnId).toBe(assistantTurn.id);
  });

  it("returns causally ordered turns when createdAt ties arrive from the repository reversed", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const createdAt = "2026-06-08T00:00:00.000Z";
    const userTurn = await repos.turns.create({
      id: "turn-user",
      threadId: thread.id,
      role: "user",
      status: "complete",
      createdAt,
    });
    const assistantTurn = await repos.turns.create({
      id: "turn-assistant",
      threadId: thread.id,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "complete",
      createdAt,
    });

    const reversedRepos = {
      ...repos,
      turns: {
        ...repos.turns,
        listByThread: async (threadId: string) =>
          [...(await repos.turns.listByThread(threadId))].reverse(),
      },
    };

    const snapshot = await buildThreadSnapshot(
      reversedRepos,
      emptyHub,
      idleRunner,
      thread.id,
      "user-1",
    );

    expect(snapshot.turns.map((turn) => turn.id)).toEqual([userTurn.id, assistantTurn.id]);
    expect(snapshot.attention).toBe("unread");
  });

  it("omits reasoning replay metadata from client blocks while preserving internal replay data", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const turn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "complete",
    });

    const reasoningBlock = await repos.blocks.create({
      id: "reasoning-block",
      turnId: turn.id,
      blockType: "reasoning",
      sequence: 0,
      textContent: "reasoning text",
      content: {
        text: "reasoning text",
        summary: "reasoning summary",
        extraDisplayField: "keep me",
        providerOptions: {
          anthropic: { signature: "anthropic-replay-signature" },
          meridian: { provider: "anthropic", model: "claude-sonnet" },
        },
      },
    });
    const thinkingBlock = await repos.blocks.create({
      id: "thinking-block",
      turnId: turn.id,
      blockType: "thinking",
      sequence: 1,
      textContent: "thinking text",
      content: {
        text: "thinking text",
        summary: "thinking summary",
        providerOptions: {
          openai: { itemId: "rs_123", encrypted: "encrypted-replay-token" },
          meridian: { provider: "openai", model: "gpt-5.1" },
        },
      },
    });
    const textBlock = await repos.blocks.create({
      id: "text-block",
      turnId: turn.id,
      blockType: "text",
      sequence: 2,
      textContent: "plain text",
      content: { text: "plain text", providerOptions: { deliberatelyUntouched: true } },
    });
    const toolUseBlock = await repos.blocks.create({
      id: "tool-use-block",
      turnId: turn.id,
      blockType: "tool_use",
      sequence: 3,
      content: { toolName: "read", arguments: { path: "README.md" } },
    });
    const toolResultBlock = await repos.blocks.create({
      id: "tool-result-block",
      turnId: turn.id,
      blockType: "tool_result",
      sequence: 4,
      content: { toolName: "read", result: "ok" },
    });

    const snapshot = await buildThreadSnapshot(repos, emptyHub, idleRunner, thread.id, "user-1");
    const snapshotBlocks = snapshot.turns[0]?.blocks ?? [];

    expect(snapshotBlocks).toHaveLength(5);
    expect(snapshotBlocks[0]).toMatchObject({
      id: reasoningBlock.id,
      textContent: "reasoning text",
      content: {
        text: "reasoning text",
        summary: "reasoning summary",
        extraDisplayField: "keep me",
      },
    });
    expect(contentObject(snapshotBlocks[0] as Block)).not.toHaveProperty("providerOptions");
    expect(snapshotBlocks[1]).toMatchObject({
      id: thinkingBlock.id,
      textContent: "thinking text",
      content: {
        text: "thinking text",
        summary: "thinking summary",
      },
    });
    expect(contentObject(snapshotBlocks[1] as Block)).not.toHaveProperty("providerOptions");
    expect(snapshotBlocks[2]).toMatchObject({
      id: textBlock.id,
      content: textBlock.content,
    });
    expect(snapshotBlocks[3]).toMatchObject({
      id: toolUseBlock.id,
      content: toolUseBlock.content,
    });
    expect(snapshotBlocks[4]).toMatchObject({
      id: toolResultBlock.id,
      content: toolResultBlock.content,
    });

    const internalBlocks = await repos.blocks.listByThread(thread.id);
    expect(contentObject(internalBlocks[0] as Block).providerOptions).toEqual(
      contentObject(reasoningBlock).providerOptions,
    );
    expect(contentObject(internalBlocks[1] as Block).providerOptions).toEqual(
      contentObject(thinkingBlock).providerOptions,
    );
  });

  it("resumes active snapshots from the projected read-model watermark before unmaterialized deltas", async () => {
    const repos = createInMemoryRepositories();
    const journal = createInMemoryEventJournalWriter();
    const hub = hubForJournal(journal);
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    await repos.threads.updateStatus(thread.id, "active");
    const userTurn = await repos.turns.create({
      threadId: thread.id,
      role: "user",
      status: "complete",
    });
    const assistantTurn = await repos.turns.create({
      threadId: thread.id,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "streaming",
    });

    await journal.appendEvent(thread.id, { type: "turn.created", turn: userTurn });
    await journal.appendEvent(thread.id, {
      type: "block.upserted",
      block: {
        id: "user-block",
        turnId: userTurn.id,
        responseId: null,
        blockType: "text",
        sequence: 0,
        content: "prompt",
        provider: null,
        status: "complete",
      },
    });
    const projectedWatermark = await journal.appendEvent(thread.id, {
      type: "turn.created",
      turn: assistantTurn,
    });
    await journal.appendEvent(thread.id, { type: "stream.delta", kind: "text", text: "Hello" });
    await journal.appendEvent(thread.id, { type: "stream.delta", kind: "text", text: " world" });

    const snapshot = await buildThreadSnapshot(
      repos,
      hub,
      { getRunningTurnId: () => assistantTurn.id },
      thread.id,
      "user-1",
    );

    expect(snapshot.turns.find((turn) => turn.id === assistantTurn.id)?.blocks).toEqual([]);
    expect(snapshot.liveState.resumeAfterSeq).toBe(`${projectedWatermark * 1000n + 999n}`);
    expect(snapshot.liveState.resumeAfterSeq).not.toBe((BigInt(snapshot.nextSeq) - 1n).toString());
  });

  it("keeps the resume watermark at materialized blocks when later deltas are still streaming", async () => {
    const repos = createInMemoryRepositories();
    const journal = createInMemoryEventJournalWriter();
    const hub = hubForJournal(journal);
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    await repos.threads.updateStatus(thread.id, "active");
    const userTurn = await repos.turns.create({
      threadId: thread.id,
      role: "user",
      status: "complete",
    });
    const assistantTurn = await repos.turns.create({
      threadId: thread.id,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "streaming",
    });
    await repos.blocks.create({
      id: "materialized-text",
      turnId: assistantTurn.id,
      blockType: "text",
      sequence: 0,
      textContent: "First sentence.",
      content: "First sentence.",
      status: "complete",
    });

    await journal.appendEvent(thread.id, { type: "turn.created", turn: userTurn });
    await journal.appendEvent(thread.id, { type: "turn.created", turn: assistantTurn });
    await journal.appendEvent(thread.id, { type: "stream.delta", kind: "text", text: "First" });
    const blockWatermark = await journal.appendEvent(thread.id, {
      type: "block.upserted",
      block: {
        id: "materialized-text",
        turnId: assistantTurn.id,
        responseId: null,
        blockType: "text",
        sequence: 0,
        content: "First sentence.",
        provider: null,
        status: "complete",
      },
    });
    await journal.appendEvent(thread.id, {
      type: "stream.delta",
      kind: "text",
      text: " Second sentence in progress",
    });

    const snapshot = await buildThreadSnapshot(
      repos,
      hub,
      { getRunningTurnId: () => assistantTurn.id },
      thread.id,
      "user-1",
    );

    expect(snapshot.turns.find((turn) => turn.id === assistantTurn.id)?.blocks).toHaveLength(1);
    expect(snapshot.liveState.resumeAfterSeq).toBe(`${blockWatermark * 1000n + 999n}`);
    expect(BigInt(snapshot.liveState.resumeAfterSeq)).toBeLessThan(BigInt(snapshot.nextSeq) - 1n);
  });
});
