/** Shared behavior contract for the in-memory and PostgreSQL transcript readers. */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { loadThreadConversationContext } from "../domain/thread-conversation-context.js";
import {
  cursorAfter,
  InvalidTranscriptCursorError,
  readTranscriptPage,
} from "../domain/transcript-page.js";
import type { InternalThreadRepositories } from "../ports/repositories.js";

export interface TranscriptPageContractHarness {
  repos: InternalThreadRepositories;
  projectId: ProjectId;
  userId: UserId;
}

export function defineTranscriptPageContract(
  createHarness: () => Promise<TranscriptPageContractHarness>,
) {
  async function fixture() {
    const { repos, projectId, userId } = await createHarness();
    const ids = new Map<string, string>();
    const id = (label: string) => {
      let value = ids.get(label);
      if (!value) {
        value = crypto.randomUUID();
        ids.set(label, value);
      }
      return value;
    };
    const root = await repos.threads.create({
      id: id("root") as ThreadId,
      projectId,
      userId,
    });
    const rootBake = await repos.threads.bakeInitialPrompt(root.id as ThreadId, {
      composedSystemPrompt: "initial root prompt",
      bakedSkillSlugs: [],
      bakedTools: [],
      contentHash: id("root-hash"),
    });
    async function bake(label: string) {
      return repos.promptBakes.create({
        ownerThreadId: root.id as ThreadId,
        composedSystemPrompt: label,
        bakedSkillSlugs: [],
        bakedTools: [],
        contentHash: id(`${label}-hash`),
      });
    }
    async function turn(
      threadId: ThreadId,
      label: string,
      role: Turn["role"] = "user",
      extra: Partial<Parameters<typeof repos.turns.create>[0]> = {},
    ) {
      const prior = await repos.turns.getLatestByThread(threadId);
      return repos.turns.create({
        id: id(label) as TurnId,
        threadId,
        prevTurnId: prior?.id as TurnId | undefined,
        role,
        origin: role === "assistant" ? "assistant" : "writer",
        status: "complete",
        ...(role === "compaction" && (extra.status ?? "complete") === "complete"
          ? { compactionModel: "contract-compaction-model" }
          : {}),
        ...extra,
      });
    }
    async function block(turnId: TurnId, label: string, sequence: number, value = label) {
      return repos.blocks.create({
        id: id(label),
        turnId,
        blockType: "text",
        sequence,
        textContent: value,
        content: { text: value },
      });
    }
    return { repos, root, rootBake: rootBake.bake, turn, block, bake, id };
  }

  async function readAll(
    repos: InternalThreadRepositories,
    thread: Thread,
    order: "newest_first" | "oldest_first",
    unit: "item" | "turn",
    limit = 2,
  ) {
    const pages = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await readTranscriptPage(repos, thread, {
        order,
        unit,
        limit,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.nextCursor;
      if (!page.hasMore) return pages;
      if (!cursor) throw new Error("A page with more transcript items must return a cursor");
    }
    throw new Error("Transcript did not finish within the test page bound");
  }

  function compareKey(
    left: { position: number; sequence: number },
    right: { position: number; sequence: number },
  ) {
    return left.position - right.position || left.sequence - right.sequence;
  }

  function updateCursor(cursor: string, field: "a" | "k", value: [number, number]) {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payload[field] = value;
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }

  describe("readTranscriptPage adapter contract", () => {
    it("returns only writer page fields", async () => {
      const { repos, root, turn } = await fixture();
      await turn(root.id as ThreadId, "writer-shape");
      const page = await readTranscriptPage(repos, root, {
        order: "newest_first",
        unit: "item",
        limit: 1,
      });
      expect(Object.keys(page).sort()).toEqual([
        "entries",
        "hasMore",
        "owners",
        "segment",
        "segmentBoundary",
      ]);
    });
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
    ] as const)("matches context for a fork of a fork (%s, %s)", async (order, unit) => {
      const { repos, root, turn, block, id } = await fixture();
      const r1 = await turn(root.id as ThreadId, "r1");
      await block(r1.id as TurnId, "r1.0", 0);
      const r2 = await turn(root.id as ThreadId, "r2", "assistant");
      await block(r2.id as TurnId, "r2.0", 0);
      const r3 = await turn(root.id as ThreadId, "r3");
      await block(r3.id as TurnId, "r3.0", 0);
      const fork1 = (
        await repos.threads.createDerivedPrimary({
          id: id("fork1") as ThreadId,
          userId: root.userId,
          projectId: root.projectId,
          workId: null,
          source: root,
          originType: "fork",
          originTurnId: r2.id as TurnId,
        })
      ).thread;
      const f1 = await repos.turns.create({
        id: id("f1") as TurnId,
        threadId: fork1.id as ThreadId,
        prevTurnId: r2.id as TurnId,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await block(f1.id as TurnId, "f1.0", 0);
      const fork2 = (
        await repos.threads.createDerivedPrimary({
          id: id("fork2") as ThreadId,
          userId: root.userId,
          projectId: root.projectId,
          workId: null,
          source: fork1,
          originType: "fork",
          originTurnId: r1.id as TurnId,
        })
      ).thread;
      const f2 = await repos.turns.create({
        id: id("f2") as TurnId,
        threadId: fork2.id as ThreadId,
        prevTurnId: r1.id as TurnId,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
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

    it("resolves three spans when a fork of a fork stops in the middle fork's local turns", async () => {
      const { repos, root, turn, block, id } = await fixture();
      const rootOne = await turn(root.id as ThreadId, "three-span-root-1");
      await block(rootOne.id as TurnId, "three-span-root-1.0", 0);
      const rootTwo = await turn(root.id as ThreadId, "three-span-root-2");
      const middle = (
        await repos.threads.createDerivedPrimary({
          id: id("three-span-middle") as ThreadId,
          userId: root.userId,
          projectId: root.projectId,
          workId: null,
          source: root,
          originType: "fork",
          originTurnId: rootTwo.id as TurnId,
        })
      ).thread;
      const middleLocal = await repos.turns.create({
        id: id("three-span-middle-local") as TurnId,
        threadId: middle.id as ThreadId,
        prevTurnId: rootTwo.id as TurnId,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await block(middleLocal.id as TurnId, "three-span-middle-local.0", 0);
      const child = (
        await repos.threads.createDerivedPrimary({
          id: id("three-span-child") as ThreadId,
          userId: root.userId,
          projectId: root.projectId,
          workId: null,
          source: middle,
          originType: "fork",
          originTurnId: middleLocal.id as TurnId,
        })
      ).thread;
      const childLocal = await repos.turns.create({
        id: id("three-span-child-local") as TurnId,
        threadId: child.id as ThreadId,
        prevTurnId: middleLocal.id as TurnId,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });

      const context = await loadThreadConversationContext(repos, child);
      const pages = await readAll(repos, child, "oldest_first", "turn");
      const actual = pages.flatMap((page) => page.entries.map((entry) => entry.turn.id));
      expect(actual).toEqual(context.turns.map((entry) => entry.id));
      expect(context.turns.map((entry) => entry.threadId)).toEqual([
        root.id,
        root.id,
        middle.id,
        child.id,
      ]);
      expect(actual).toContain(childLocal.id);
    });

    it("does not emit a blockless item after paging past a turn's lowest block", async () => {
      const { repos, root, turn, block, id } = await fixture();
      const first = await turn(root.id as ThreadId, "phantom-1");
      await block(first.id as TurnId, "phantom-1.0", 0);
      await block(first.id as TurnId, "phantom-1.1", 1);
      await turn(root.id as ThreadId, "phantom-2");
      const last = await turn(root.id as ThreadId, "phantom-3");
      await block(last.id as TurnId, "phantom-3.0", 0);
      await block(last.id as TurnId, "phantom-3.1", 1);
      await block(last.id as TurnId, "phantom-3.2", 2);

      const pages = await readAll(repos, root, "newest_first", "item", 3);
      const actual = pages.flatMap((page) =>
        page.entries.flatMap((entry) =>
          entry.blocks.length > 0
            ? entry.blocks.map((entryBlock) => `${entry.turn.id}:${entryBlock.sequence}`)
            : [`${entry.turn.id}:-1`],
        ),
      );
      expect(
        actual.sort((left, right) => {
          const [leftId, leftSequence] = left.split(":");
          const [rightId, rightSequence] = right.split(":");
          const position = (key: string) => [first.id, id("phantom-2"), last.id].indexOf(key);
          return (
            position(rightId ?? "") - position(leftId ?? "") ||
            Number(rightSequence) - Number(leftSequence)
          );
        }),
      ).toEqual([
        `${last.id}:2`,
        `${last.id}:1`,
        `${last.id}:0`,
        `${id("phantom-2")}:-1`,
        `${first.id}:1`,
        `${first.id}:0`,
      ]);
    });

    it("pages newest-first through a turn with more blocks than the item limit", async () => {
      const { repos, root, turn, block } = await fixture();
      const longTurn = await turn(root.id as ThreadId, "long-turn");
      for (let sequence = 0; sequence < 8; sequence++) {
        await block(longTurn.id as TurnId, `long-turn.${sequence}`, sequence);
      }
      const pages = await readAll(repos, root, "newest_first", "item", 3);
      const actual = pages.flatMap((page) =>
        page.entries.flatMap((entry) => entry.blocks.map((entryBlock) => entryBlock.sequence)),
      );
      expect(actual.sort((left, right) => right - left)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    });

    it("pins a cursor chain to the settled prefix while a compaction and later turns settle", async () => {
      const { repos, root, turn, block, id, bake } = await fixture();
      const first = await turn(root.id as ThreadId, "s1");
      await block(first.id as TurnId, "s1.0", 0);
      const anchorTurn = await turn(root.id as ThreadId, "s2", "assistant");
      const anchorBlock = await block(anchorTurn.id as TurnId, "s2.0", 0, "before");
      const compaction = await turn(root.id as ThreadId, "c1", "compaction", {
        status: "pending",
        metadata: { compactedThrough: { turnId: first.id }, pinnedRequestTurnIds: [anchorTurn.id] },
      });
      const page1 = await readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "item",
        limit: 1,
      });
      expect(page1.entries.map((entry) => entry.turn.id)).toEqual([first.id]);
      expect(page1.segment.index).toBe(0);
      expect(page1.nextCursor).toBeDefined();

      await repos.blocks.replaceExisting({
        id: anchorBlock.id,
        turnId: anchorTurn.id as TurnId,
        blockType: "text",
        sequence: 0,
        content: { text: "revised in place" },
      });
      const lateWriter = await repos.turns.create({
        id: id("late-writer") as TurnId,
        threadId: root.id as ThreadId,
        prevTurnId: compaction.id as TurnId,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await block(compaction.id as TurnId, "c1.summary", 0, "summary");
      const rebake = await bake("rebake");
      await repos.turns.updateStatus(compaction.id as TurnId, {
        status: "complete",
        promptBakeId: rebake.id,
        compactionModel: "contract-compaction-model",
        metadata: { compactedThrough: { turnId: first.id }, pinnedRequestTurnIds: [anchorTurn.id] },
      });
      const streaming = await repos.turns.create({
        id: id("streaming-after-compaction") as TurnId,
        threadId: root.id as ThreadId,
        prevTurnId: lateWriter.id as TurnId,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      await block(streaming.id as TurnId, "streaming-after-compaction.0", 0);
      const steer = await repos.turns.create({
        id: id("steer") as TurnId,
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
      ).toEqual([anchorBlock.id]);
      expect(page2.segment.index).toBe(0);
      expect(
        page2.entries.some((entry) =>
          [compaction.id, lateWriter.id, streaming.id, steer.id].includes(entry.turn.id),
        ),
      ).toBe(false);
    });

    it("keeps segment indexes stable while a cursor chain crosses a barrier and the thread grows", async () => {
      const { repos, root, turn, block, bake } = await fixture();
      const before = await turn(root.id as ThreadId, "stable-segment-before");
      await block(before.id as TurnId, "stable-segment-before.0", 0);
      const compactBake = await bake("stable-segment-compact-bake");
      const compaction = await turn(root.id as ThreadId, "stable-segment-compact", "compaction", {
        promptBakeId: compactBake.id,
        metadata: {
          compactedThrough: { turnId: before.id },
          pinnedRequestTurnIds: [before.id],
        },
      });
      await block(compaction.id as TurnId, "stable-segment-compact.0", 0);
      const after = await turn(root.id as ThreadId, "stable-segment-after");
      await block(after.id as TurnId, "stable-segment-after.0", 0);

      const first = await readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "turn",
        limit: 1,
      });
      if (!first.nextCursor) throw new Error("Expected a cursor before the barrier");
      const late = await turn(root.id as ThreadId, "stable-segment-late");
      await block(late.id as TurnId, "stable-segment-late.0", 0);

      const second = await readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "turn",
        limit: 1,
        cursor: first.nextCursor,
      });
      if (!second.nextCursor) throw new Error("Expected a cursor at the barrier");
      const later = await turn(root.id as ThreadId, "stable-segment-later");
      await block(later.id as TurnId, "stable-segment-later.0", 0);

      const third = await readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "turn",
        limit: 1,
        cursor: second.nextCursor,
      });
      expect([
        ...first.entries.map((entry) => entry.turn.id),
        ...second.entries.map((entry) => entry.turn.id),
        ...third.entries.map((entry) => entry.turn.id),
      ]).toEqual([before.id, compaction.id, after.id]);
      expect([first.segment.index, second.segment.index, third.segment.index]).toEqual([0, 1, 1]);
      expect([first.segmentBoundary, second.segmentBoundary, third.segmentBoundary]).toEqual([
        true,
        false,
        false,
      ]);
      expect(third.hasMore).toBe(false);
    });

    it("returns only the newest bounded unsettled preview on the first effective newest-first page", async () => {
      const { repos, root, turn, block, id } = await fixture();
      const settled = await turn(root.id as ThreadId, "settled");
      await block(settled.id as TurnId, "settled.0", 0);
      const streaming = await repos.turns.create({
        id: id("streaming") as TurnId,
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
        id: id("queued-writer") as TurnId,
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
      const { repos, root, turn, id } = await fixture();
      const settled = await turn(root.id as ThreadId, "turn-sized-settled");
      const streaming = await repos.turns.create({
        id: id("turn-sized-streaming") as TurnId,
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

    it("forks before and after a compaction retain one and two segments respectively", async () => {
      const { repos, root, turn, id, bake } = await fixture();
      const before = await turn(root.id as ThreadId, "fork-before");
      const compactBake = await bake("fork-compact-bake");
      const compact = await turn(root.id as ThreadId, "fork-compact", "compaction", {
        promptBakeId: compactBake.id,
        metadata: { compactedThrough: { turnId: before.id }, pinnedRequestTurnIds: [before.id] },
      });
      const after = await turn(root.id as ThreadId, "fork-after");
      const beforeFork = (
        await repos.threads.createDerivedPrimary({
          id: id("fork-cut-before") as ThreadId,
          userId: root.userId,
          projectId: root.projectId,
          workId: null,
          source: root,
          originType: "fork",
          originTurnId: before.id as TurnId,
        })
      ).thread;
      const afterFork = (
        await repos.threads.createDerivedPrimary({
          id: id("fork-cut-after") as ThreadId,
          userId: root.userId,
          projectId: root.projectId,
          workId: null,
          source: root,
          originType: "fork",
          originTurnId: after.id as TurnId,
        })
      ).thread;
      const beforePages = await readAll(repos, beforeFork, "oldest_first", "turn");
      const afterPages = await readAll(repos, afterFork, "oldest_first", "turn");
      expect([...new Set(beforePages.map((page) => page.segment.index))]).toEqual([0]);
      expect([...new Set(afterPages.map((page) => page.segment.index))]).toEqual([0, 1]);
      expect(afterPages.flatMap((page) => page.entries.map((entry) => entry.turn.id))).toContain(
        compact.id,
      );
    });

    it("pins a newest-first chain while the thread grows", async () => {
      const { repos, root, turn, block, id } = await fixture();
      const original = [] as Turn[];
      for (let index = 0; index < 6; index++) {
        const created = await turn(root.id as ThreadId, `growth-${index}`);
        await block(created.id as TurnId, `growth-${index}.0`, 0);
        original.push(created);
      }
      const originalKeys = original.flatMap((entry) => ({
        position: entry.position,
        sequence: 0,
        id: id(`growth-${original.indexOf(entry)}.0`),
      }));
      let cursor: string | undefined;
      const seenNewest: string[] = [];
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await readTranscriptPage(repos, root, {
          order: "newest_first",
          unit: "item",
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seenNewest.push(...page.entries.flatMap((entry) => entry.blocks.map((part) => part.id)));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        const appended = await turn(root.id as ThreadId, `newest-growth-${pageNumber}`);
        await block(appended.id as TurnId, `newest-growth-${pageNumber}.0`, 0);
        expect(cursor).toBeDefined();
      }
      expect(seenNewest.sort()).toEqual(originalKeys.map((key) => key.id).sort());
    });

    it("ends an oldest-first walk even as a new turn is appended after each page", async () => {
      const { repos, root, turn, block } = await fixture();
      const original: string[] = [];
      for (let index = 0; index < 6; index++) {
        const created = await turn(root.id as ThreadId, `walk-${index}`);
        await block(created.id as TurnId, `walk-${index}.0`, 0);
        original.push(created.id);
      }
      let cursor: string | undefined;
      const seen: string[] = [];
      let appends = 0;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await readTranscriptPage(repos, root, {
          order: "oldest_first",
          unit: "item",
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.entries.flatMap((entry) => entry.blocks.map((part) => part.turnId)));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        const appended = await turn(root.id as ThreadId, `walk-growth-${pageNumber}`);
        await block(appended.id as TurnId, `walk-growth-${pageNumber}.0`, 0);
        appends += 1;
      }
      expect(seen).toEqual(original);
      expect(seen).toHaveLength(original.length);
      expect(appends).toBe(original.length - 1);
    });

    it("rejects a cursor key beyond its anchor and an anchor above the first unsettled turn", async () => {
      const { repos, root, turn, id } = await fixture();
      await turn(root.id as ThreadId, "cursor-anchor-1");
      const lastSettled = await turn(root.id as ThreadId, "cursor-anchor-2");
      const unsettled = await repos.turns.create({
        id: id("cursor-unsettled") as TurnId,
        threadId: root.id as ThreadId,
        prevTurnId: lastSettled.id as TurnId,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      const page = await readTranscriptPage(repos, root, {
        order: "oldest_first",
        unit: "turn",
        limit: 1,
      });
      const firstEntry = page.entries[0];
      if (!page.nextCursor || !firstEntry) throw new Error("Expected a transcript cursor page");
      const cursor = page.nextCursor;
      const invalidKey = updateCursor(cursor, "k", [firstEntry.turn.position + 2, -1]);
      await expect(
        readTranscriptPage(repos, root, {
          order: "oldest_first",
          unit: "turn",
          limit: 1,
          cursor: invalidKey,
        }),
      ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);

      const invalidAnchor = updateCursor(cursor, "a", [unsettled.position, -1]);
      await expect(
        readTranscriptPage(repos, root, {
          order: "oldest_first",
          unit: "turn",
          limit: 1,
          cursor: invalidAnchor,
        }),
      ).rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    });

    it("rejects malformed and mismatched cursors and allows resume after a trimmed key", async () => {
      const { repos, root, turn, block, id } = await fixture();
      const first = await turn(root.id as ThreadId, "cursor-1");
      const firstBlock = await block(first.id as TurnId, "cursor-1.0", 0);
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
      expect(resumed.entries.flatMap((entry) => entry.blocks.map((part) => part.id))).toEqual([
        id("cursor-1.1"),
      ]);
      expect(firstBlock.id).toBe(id("cursor-1.0"));
      const otherThread = await repos.threads.create({
        id: id("other-thread") as ThreadId,
        projectId: root.projectId,
        userId: root.userId as UserId,
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
}
