/** Contract tests for stable keyset pages over plain and inherited transcripts. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../adapters/in-memory/index.js";
import { loadThreadConversationContext } from "./thread-conversation-context.js";
import {
  cursorAfter,
  InvalidTranscriptCursorError,
  readTranscriptPage,
} from "./transcript-page.js";

const PROJECT_ID = "project" as never;
const USER_ID = "writer" as never;

async function fixture() {
  const repos = createInMemoryRepositories();
  const root = await repos.threads.create({
    id: "root" as ThreadId,
    projectId: PROJECT_ID,
    userId: USER_ID,
  });
  const rootBake = await repos.threads.bakeInitialPrompt(root.id as ThreadId, {
    composedSystemPrompt: "initial root prompt",
    bakedSkillSlugs: [],
    bakedTools: [],
    contentHash: "root-hash",
  });
  async function turn(
    threadId: ThreadId,
    id: string,
    role: Turn["role"] = "user",
    extra: Partial<Parameters<typeof repos.turns.create>[0]> = {},
  ) {
    const prior = await repos.turns.getLatestByThread(threadId);
    return repos.turns.create({
      id: id as TurnId,
      threadId,
      prevTurnId: prior?.id as TurnId | undefined,
      role,
      origin: role === "assistant" ? "assistant" : "writer",
      status: "complete",
      ...extra,
    });
  }
  async function block(turnId: TurnId, id: string, sequence: number, value = id) {
    return repos.blocks.create({
      id,
      turnId,
      blockType: "text",
      sequence,
      textContent: value,
      content: { text: value },
    });
  }
  return { repos, root, rootBake: rootBake.bake, turn, block };
}

function compareKey(
  left: { position: number; sequence: number },
  right: { position: number; sequence: number },
) {
  return left.position - right.position || left.sequence - right.sequence;
}

async function readAll(
  repos: Awaited<ReturnType<typeof fixture>>["repos"],
  thread: Thread,
  order: "newest_first" | "oldest_first",
  unit: "item" | "turn",
) {
  const pages = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
    const page = await readTranscriptPage(repos, thread, {
      order,
      unit,
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    cursor = page.nextCursor;
    if (!page.hasMore) return pages;
    if (!cursor) throw new Error("A page with more transcript items must return a cursor");
  }
  throw new Error("Transcript did not finish within the test page bound");
}

describe("readTranscriptPage", () => {
  it.each([
    ["oldest_first", "item"],
    ["oldest_first", "turn"],
    ["newest_first", "item"],
    ["newest_first", "turn"],
  ] as const)("matches a plain thread's loader (%s, %s)", async (order, unit) => {
    const { repos, root, turn, block } = await fixture();
    const one = await turn(root.id as ThreadId, "plain-1");
    await block(one.id as TurnId, "plain-1.0", 0);
    await block(one.id as TurnId, "plain-1.1", 1);
    const two = await turn(root.id as ThreadId, "plain-2", "assistant");
    const context = await loadThreadConversationContext(repos, root);
    const pages = await readAll(repos, root, order, unit);
    const actual = pages
      .flatMap((page) =>
        page.entries.flatMap((entry) =>
          entry.blocks.length > 0
            ? entry.blocks.map((entryBlock) => ({
                position: entry.turn.position,
                sequence: entryBlock.sequence,
                id: entryBlock.id,
              }))
            : [{ position: entry.turn.position, sequence: -1, id: entry.turn.id }],
        ),
      )
      .sort(compareKey);
    const blocksByTurn = new Map<string, Block[]>();
    for (const entryBlock of context.blocks) {
      const group = blocksByTurn.get(entryBlock.turnId) ?? [];
      group.push(entryBlock);
      blocksByTurn.set(entryBlock.turnId, group);
    }
    const expected = context.turns
      .flatMap((entry) => {
        const ownBlocks = blocksByTurn.get(entry.id) ?? [];
        return ownBlocks.length > 0
          ? ownBlocks.map((entryBlock) => ({
              position: entry.position,
              sequence: entryBlock.sequence,
              id: entryBlock.id,
            }))
          : [{ position: entry.position, sequence: -1, id: entry.id }];
      })
      .sort(compareKey);
    expect(actual).toEqual(expected);
    expect(actual.at(-1)?.id).toBe(two.id);
  });

  it.each([
    ["oldest_first", "item"],
    ["oldest_first", "turn"],
    ["newest_first", "item"],
    ["newest_first", "turn"],
  ] as const)("matches conversation context for a fork of a fork (%s, %s)", async (order, unit) => {
    const { repos, root, turn, block } = await fixture();
    const r1 = await turn(root.id as ThreadId, "r1");
    await block(r1.id as TurnId, "r1.0", 0);
    const r2 = await turn(root.id as ThreadId, "r2", "assistant");
    await block(r2.id as TurnId, "r2.0", 0);
    const r3 = await turn(root.id as ThreadId, "r3");
    await block(r3.id as TurnId, "r3.0", 0);
    const fork1 = (
      await repos.threads.createDerivedPrimary({
        id: "fork1" as ThreadId,
        userId: USER_ID,
        projectId: PROJECT_ID,
        workId: null,
        source: root,
        originType: "fork",
        originTurnId: r2.id as TurnId,
      })
    ).thread;
    const f1 = await repos.turns.create({
      id: "f1" as TurnId,
      threadId: fork1.id as ThreadId,
      prevTurnId: r2.id as TurnId,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await block(f1.id as TurnId, "f1.0", 0);
    const fork2 = (
      await repos.threads.createDerivedPrimary({
        id: "fork2" as ThreadId,
        userId: USER_ID,
        projectId: PROJECT_ID,
        workId: null,
        source: fork1,
        originType: "fork",
        originTurnId: r1.id as TurnId,
      })
    ).thread;
    const f2 = await repos.turns.create({
      id: "f2" as TurnId,
      threadId: fork2.id as ThreadId,
      prevTurnId: r1.id as TurnId,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    // A blockless settled turn is an item at sequence -1.
    const context = await loadThreadConversationContext(repos, fork2);
    const pages = await readAll(repos, fork2, order, unit);
    const entries = pages.flatMap((page) => page.entries);
    const expectedTurns = context.turns.map((entry) => entry.id);
    const actualTurns = [...new Map(entries.map((entry) => [entry.turn.id, entry])).values()]
      .sort((left, right) => left.turn.position - right.turn.position)
      .map((entry) => entry.turn.id);
    expect(actualTurns).toEqual(expectedTurns);
    expect(entries.map((entry) => entry.ownerThreadId)).toEqual(
      entries.map((entry) => entry.turn.threadId),
    );
    if (unit === "item") {
      const actual = entries
        .flatMap((entry) =>
          entry.blocks.length > 0
            ? entry.blocks.map((entryBlock) => ({
                position: entry.turn.position,
                sequence: entryBlock.sequence,
                id: entryBlock.id,
              }))
            : [{ position: entry.turn.position, sequence: -1, id: entry.turn.id }],
        )
        .sort(compareKey);
      const expectedByTurn = new Map<string, Block[]>();
      for (const entryBlock of context.blocks) {
        const group = expectedByTurn.get(entryBlock.turnId) ?? [];
        group.push(entryBlock);
        expectedByTurn.set(entryBlock.turnId, group);
      }
      const expected = context.turns
        .flatMap((entry) => {
          const ownBlocks = expectedByTurn.get(entry.id) ?? [];
          return ownBlocks.length > 0
            ? ownBlocks.map((entryBlock) => ({
                position: entry.position,
                sequence: entryBlock.sequence,
                id: entryBlock.id,
              }))
            : [{ position: entry.position, sequence: -1, id: entry.id }];
        })
        .sort(compareKey);
      expect(actual).toEqual(expected);
    }
    expect([r1.id, r2.id, r3.id, f2.id]).toContain(expectedTurns.at(-1));
  });

  it("pins a cursor chain to the settled prefix while a compaction and later turns settle", async () => {
    const { repos, root, turn, block } = await fixture();
    const first = await turn(root.id as ThreadId, "s1");
    await block(first.id as TurnId, "s1.0", 0);
    const anchorTurn = await turn(root.id as ThreadId, "s2", "assistant");
    await block(anchorTurn.id as TurnId, "s2.0", 0, "before");
    const compaction = await turn(root.id as ThreadId, "c1", "compaction", {
      status: "pending",
      metadata: { compactedThrough: { turnId: first.id }, pinnedRequestTurnId: anchorTurn.id },
    });
    const page1 = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "item",
      limit: 1,
    });
    expect(page1.entries.map((entry) => entry.turn.id)).toEqual([first.id]);
    expect(page1.segment.index).toBe(0);
    expect(page1.nextCursor).toBeDefined();

    // Existing settled content may be replaced without adding a new key.
    await repos.blocks.replaceExisting({
      id: "s2.0",
      turnId: anchorTurn.id as TurnId,
      blockType: "text",
      sequence: 0,
      content: { text: "revised in place" },
    });
    const lateWriter = await repos.turns.create({
      id: "late-writer" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: compaction.id as TurnId,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await block(compaction.id as TurnId, "c1.summary", 0, "summary");
    await repos.turns.updateStatus(compaction.id as TurnId, {
      status: "complete",
      promptBakeId: "rebake" as never,
      metadata: { compactedThrough: { turnId: first.id }, pinnedRequestTurnId: anchorTurn.id },
    });
    const streaming = await repos.turns.create({
      id: "streaming-after-compaction" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: lateWriter.id as TurnId,
      role: "assistant",
      origin: "assistant",
      status: "streaming",
    });
    await block(streaming.id as TurnId, "streaming-after-compaction.0", 0);
    const steer = await repos.turns.create({
      id: "steer" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: streaming.id as TurnId,
      role: "user",
      origin: "writer",
      status: "complete",
    });

    const page2 = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "item",
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(
      page2.entries.flatMap((entry) => entry.blocks.map((entryBlock) => entryBlock.id)),
    ).toEqual(["s2.0"]);
    expect(page2.segment.index).toBe(0);
    expect(
      page2.entries.some((entry) =>
        [compaction.id, lateWriter.id, streaming.id, steer.id].includes(entry.turn.id),
      ),
    ).toBe(false);
  });

  it("returns only the newest bounded unsettled preview on the first effective newest-first page", async () => {
    const { repos, root, turn, block } = await fixture();
    const settled = await turn(root.id as ThreadId, "settled");
    await block(settled.id as TurnId, "settled.0", 0);
    const streaming = await repos.turns.create({
      id: "streaming" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: settled.id as TurnId,
      role: "assistant",
      origin: "assistant",
      status: "streaming",
    });
    for (let sequence = 0; sequence < 200; sequence++) {
      await block(streaming.id as TurnId, `streaming.${sequence}`, sequence);
    }
    const late = await repos.turns.create({
      id: "queued-writer" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: streaming.id as TurnId,
      role: "user",
      origin: "writer",
      status: "complete",
    });

    const first = await readTranscriptPage(repos, root, {
      order: "newest_first",
      unit: "item",
      limit: 3,
    });
    expect(first.unsettledTail?.[0]?.turn.id).toBe(late.id);
    expect(
      first.unsettledTail
        ?.find((entry) => entry.turn.id === streaming.id)
        ?.blocks.map((entryBlock) => entryBlock.sequence),
    ).toEqual([198, 199]);
    expect(
      first.entries.flatMap((entry) => entry.blocks.map((entryBlock) => entryBlock.id)),
    ).toEqual([]);
    expect(first.hasMore).toBe(true);
    const next = await readTranscriptPage(repos, root, {
      order: "newest_first",
      unit: "item",
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(next.unsettledTail).toBeUndefined();
    expect(next.entries.map((entry) => entry.turn.id)).toContain(settled.id);
  });

  it("continues the settled chain after a turn-sized unsettled preview fills the page", async () => {
    const { repos, root, turn } = await fixture();
    const settled = await turn(root.id as ThreadId, "turn-sized-settled");
    const streaming = await repos.turns.create({
      id: "turn-sized-streaming" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: settled.id as TurnId,
      role: "assistant",
      origin: "assistant",
      status: "streaming",
    });
    const first = await readTranscriptPage(repos, root, {
      order: "newest_first",
      unit: "turn",
      limit: 1,
    });
    expect(first.unsettledTail?.map((entry) => entry.turn.id)).toEqual([streaming.id]);
    const next = await readTranscriptPage(repos, root, {
      order: "newest_first",
      unit: "turn",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(next.entries.map((entry) => entry.turn.id)).toEqual([settled.id]);
  });

  it("stops pages at complete compaction and undo-marker boundaries, excluding errors and pending rows", async () => {
    const { repos, root, rootBake, turn, block } = await fixture();
    const before = await turn(root.id as ThreadId, "before");
    await block(before.id as TurnId, "before.0", 0);
    const compact = await turn(root.id as ThreadId, "compact", "compaction", {
      promptBakeId: "bake-2" as never,
      metadata: {
        compactedThrough: { turnId: before.id, blockSequence: 0 },
        pinnedRequestTurnId: before.id,
      },
    });
    await block(compact.id as TurnId, "compact.0", 0);
    const errorCompaction = await turn(root.id as ThreadId, "failed-compact", "compaction", {
      status: "error",
      promptBakeId: null,
    });
    const undo = await turn(root.id as ThreadId, "undo", "system", {
      promptBakeId: "bake-3" as never,
      metadata: { kind: "compaction_undo", revertsCompactionTurnId: compact.id },
    });
    await block(undo.id as TurnId, "undo.0", 0);
    const pending = await repos.turns.create({
      id: "pending-compact" as TurnId,
      threadId: root.id as ThreadId,
      prevTurnId: undo.id as TurnId,
      role: "compaction",
      origin: "system",
      status: "pending",
    });
    const oldest = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "turn",
      limit: 10,
    });
    expect(oldest.entries.map((entry) => entry.turn.id)).toEqual([before.id]);
    expect(oldest.segment.index).toBe(0);
    expect(oldest.segment.bakeId).toBe(rootBake.id);
    expect(oldest.segmentBoundary).toBe(true);
    const middle = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "turn",
      limit: 10,
      cursor: oldest.nextCursor,
    });
    expect(middle.entries.map((entry) => entry.turn.id)).toEqual([compact.id, errorCompaction.id]);
    expect(middle.segment.index).toBe(1);
    expect(middle.segment.bakeId).toBe("bake-2");
    expect(middle.segment.openedBy).toEqual({ turnId: compact.id, kind: "compaction" });
    expect(middle.segment.compactedThrough).toEqual({ turnId: before.id, blockSequence: 0 });
    expect(middle.segmentBoundary).toBe(true);
    const final = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "turn",
      limit: 10,
      cursor: middle.nextCursor,
    });
    expect(final.entries.map((entry) => entry.turn.id)).toEqual([undo.id]);
    expect(final.segment.index).toBe(2);
    expect(final.segment.bakeId).toBe("bake-3");
    expect(final.segment.openedBy).toEqual({ turnId: undo.id, kind: "undo_marker" });
    expect(final.entries.some((entry) => entry.turn.id === pending.id)).toBe(false);
    const newestPages = await readAll(repos, root, "newest_first", "turn");
    expect(newestPages.map((page) => page.segment.index)).toEqual([2, 1, 0]);
    expect(newestPages.flatMap((page) => page.entries.map((entry) => entry.turn.id))).toEqual([
      undo.id,
      compact.id,
      errorCompaction.id,
      before.id,
    ]);
  });

  it("rejects malformed and mismatched cursors and lets consumers resume after a trimmed key", async () => {
    const { repos, root, turn, block } = await fixture();
    const first = await turn(root.id as ThreadId, "cursor-1");
    await block(first.id as TurnId, "cursor-1.0", 0);
    await block(first.id as TurnId, "cursor-1.1", 1);
    await turn(root.id as ThreadId, "cursor-2");
    const page = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "item",
      limit: 2,
    });
    expect(page.nextCursor).toBeDefined();
    const trimmed = cursorAfter(page.nextCursor as string, {
      position: first.position,
      sequence: 0,
    });
    const resumed = await readTranscriptPage(repos, root, {
      order: "oldest_first",
      unit: "item",
      limit: 1,
      cursor: trimmed,
    });
    expect(
      resumed.entries.flatMap((entry) => entry.blocks.map((entryBlock) => entryBlock.id)),
    ).toEqual(["cursor-1.1"]);
    const otherThread = await repos.threads.create({
      id: "other-thread" as ThreadId,
      projectId: PROJECT_ID,
      userId: USER_ID,
    });
    await expect(
      readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "item",
        limit: 1,
        cursor: "not/base64",
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await expect(
      readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "item",
        limit: 1,
        cursor: "",
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await expect(
      readTranscriptPage(repos, root, {
        order: "newest_first",
        unit: "item",
        limit: 1,
        cursor: page.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await expect(
      readTranscriptPage(repos, otherThread, {
        order: "oldest_first",
        unit: "item",
        limit: 1,
        cursor: page.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await expect(
      readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "turn",
        limit: 1,
        cursor: page.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await expect(
      readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "item",
        limit: 1,
        range: "inherited",
        cursor: page.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
  });
});
