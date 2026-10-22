/** Postgres contracts for the stored conversational chat activity projection. */
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows } from "../../../../test-support/drizzle-reset.js";
import { workUpdateMetadata } from "../../index.js";
import { createDrizzleRepositoriesForTest } from "./repositories.js";

const USER = "00000000-0000-4000-8000-000000000891";
const PROJECT = "00000000-0000-4000-8000-000000000892";
const THREAD = "00000000-0000-4000-8000-000000000893";
const url = process.env.DATABASE_URL;

if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? "")) {
  describe.skip("chat feed activity (postgres)", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("chat feed activity (postgres)", () => {
    const db = createDb(url, { max: 3 });
    const repos = createDrizzleRepositoriesForTest(db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users, schema.threads]);
      await db.insert(schema.users).values(conformanceUserValues(USER, "chat-activity"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Chat", slug: "chat" });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD,
        id: THREAD,
        projectId: PROJECT,
        createdByUserId: USER,
      });
    });
    afterAll(() => db.close());

    async function activity() {
      return (
        await repos.chatFeed.queryPage({
          projectId: PROJECT,
          userId: USER,
          after: null,
          limit: 10,
          favorite: false,
          search: null,
          workId: null,
        })
      )[0]?.lastActivityAt;
    }

    it("advances when the active conversational turn completes", async () => {
      const turn = await repos.turns.create({
        threadId: THREAD,
        role: "assistant",
        origin: "assistant",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
      await repos.turns.updateStatus(turn.id, {
        status: "complete",
        completedAt: "2025-01-01T00:01:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:01:00.000000Z");
    });

    it("keeps a parked interrupt action-required after a visible writer turn anchors the head", async () => {
      const parkedAssistant = await repos.turns.create({
        threadId: THREAD,
        role: "assistant",
        origin: "assistant",
        status: "waiting_interrupt",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const writerTurn = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: parkedAssistant.id,
        role: "user",
        origin: "writer",
        status: "complete",
        createdAt: "2025-01-01T00:01:00.000Z",
      });
      await repos.blocks.create({
        turnId: writerTurn.id,
        blockType: "text",
        sequence: 0,
        textContent: "one more detail",
      });

      const item = (
        await repos.chatFeed.queryPage({
          projectId: PROJECT,
          userId: USER,
          after: null,
          limit: 10,
          favorite: false,
          search: null,
          workId: null,
        })
      )[0];
      const [thread] = await db
        .select({ head: schema.threads.conversationalLeafTurnId })
        .from(schema.threads)
        .where(eq(schema.threads.id, THREAD));

      expect(thread?.head).toBe(writerTurn.id);
      expect(item).toMatchObject({
        actionRequired: true,
        lastMessagePreview: "one more detail",
      });
      await expect(repos.threads.listByProject(PROJECT)).resolves.toMatchObject([
        { actionRequired: true },
      ]);
    });

    it("moves the head past a forgotten failure to the reply before it, or to the message that forgot it", async () => {
      // Risk (C9): the chat list still previewing the abandoned exchange, because the recursion stopped at
      // the forgotten assistant or the forgotten message anchored the head.
      const head = async () =>
        (
          await db
            .select({ head: schema.threads.conversationalLeafTurnId })
            .from(schema.threads)
            .where(eq(schema.threads.id, THREAD))
        )[0]?.head;
      const say = async (
        prevTurnId: string | undefined,
        role: "user" | "assistant",
        text: string,
        status = "complete",
      ) => {
        const created = await repos.turns.create({
          threadId: THREAD,
          ...(prevTurnId ? { prevTurnId } : {}),
          role,
          origin: role === "user" ? "writer" : "assistant",
          status: status as never,
        });
        if (text)
          await repos.blocks.create({
            turnId: created.id,
            blockType: "text",
            sequence: 0,
            textContent: text,
          });
        return created;
      };
      const answered = await say(undefined, "assistant", "earlier reply");
      const abandoned = await say(answered.id, "user", "abandoned message");
      const failed = await say(abandoned.id, "assistant", "", "error");
      expect(await head()).toBe(failed.id);
      // A compaction reservation is a closing row that is no visible head; it forgets the exchange.
      const reservation = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: failed.id,
        role: "compaction",
        origin: "system",
        status: "pending",
      });
      await repos.turns.forgetTurns([abandoned.id, failed.id], reservation.id);
      expect(await head()).toBe(answered.id);
      // A writer message that forgets a failure is itself the head and the preview.
      const second = await say(reservation.id, "user", "second abandoned");
      const secondFailed = await say(second.id, "assistant", "", "error");
      const next = await say(secondFailed.id, "user", "the next message");
      await repos.turns.forgetTurns([second.id, secondFailed.id], next.id);
      expect(await head()).toBe(next.id);
      expect(
        (
          await repos.chatFeed.queryPage({
            projectId: PROJECT,
            userId: USER,
            after: null,
            limit: 10,
            favorite: false,
            search: null,
            workId: null,
          })
        )[0],
      ).toMatchObject({ lastMessagePreview: "the next message" });
    });

    it("does not advance for a hidden work-context system update", async () => {
      const first = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        origin: "writer",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const hidden = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: first.id,
        role: "user",
        origin: "system",
        metadata: workUpdateMetadata(),
        createdAt: "2025-01-01T00:05:00.000Z",
      });
      await repos.turns.updateStatus(hidden.id, {
        status: "complete",
        completedAt: "2025-01-01T00:06:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
    });

    it("does not advance for a hidden subagent_update continuation, even with a custom block", async () => {
      // A background child's completion notice is a system-role turn carrying
      // `{ kind: "subagent_update" }` (messageTurnFor in inbox-context.ts). It
      // never anchors the head, unlike an ordinary custom-block system turn
      // below: `kind: "subagent_update"` overrides having a custom block.
      const first = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        origin: "writer",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const hidden = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: first.id,
        role: "system",
        origin: "system",
        metadata: { kind: "subagent_update", handle: "h1", outcome: "success", execution: "e1" },
        createdAt: "2025-01-01T00:05:00.000Z",
      });
      await repos.turns.updateStatus(hidden.id, {
        status: "complete",
        completedAt: "2025-01-01T00:06:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
      await repos.blocks.upsert({
        id: "00000000-0000-4000-8000-000000000895",
        turnId: hidden.id,
        blockType: "custom",
        sequence: 0,
        content: { kind: "notice" },
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
    });

    it("advances when a custom block makes a system turn visible, not for text", async () => {
      const first = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        origin: "writer",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const system = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: first.id,
        role: "system",
        origin: "system",
        createdAt: "2025-01-01T00:05:00.000Z",
      });
      await repos.blocks.create({
        turnId: system.id,
        blockType: "text",
        sequence: 0,
        textContent: "hidden",
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
      await repos.blocks.upsert({
        id: "00000000-0000-4000-8000-000000000894",
        turnId: system.id,
        blockType: "custom",
        sequence: 1,
        content: { kind: "notice" },
      });
      expect(await activity()).toBe("2025-01-01T00:05:00.000000Z");
    });

    it("moves activity to the newest sibling turn set as the active leaf, not creation order", async () => {
      const root = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        origin: "writer",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      await repos.turns.create({
        threadId: THREAD,
        prevTurnId: root.id,
        role: "assistant",
        origin: "assistant",
        createdAt: "2025-01-01T00:02:00.000Z",
      });
      const secondSibling = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: root.id,
        role: "assistant",
        origin: "assistant",
        createdAt: "2025-01-01T00:01:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:01:00.000000Z");
      const [stored] = await db
        .select({ leaf: schema.threads.conversationalLeafTurnId })
        .from(schema.threads)
        .where(eq(schema.threads.id, THREAD));
      expect(stored?.leaf).toBe(secondSibling.id);
    });

    it("recomputes when active_leaf_turn_id is updated directly to an existing sibling", async () => {
      // Proves the trigger is the single owner: no repository method is
      // called here, only a raw UPDATE of the thread row's active leaf, the
      // same shape a future branch-switch writer would perform.
      const root = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        origin: "writer",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const firstSibling = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: root.id,
        role: "assistant",
        origin: "assistant",
        createdAt: "2025-01-01T00:01:00.000Z",
      });
      await repos.turns.create({
        threadId: THREAD,
        prevTurnId: root.id,
        role: "assistant",
        origin: "assistant",
        createdAt: "2025-01-01T00:02:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:02:00.000000Z");
      await db
        .update(schema.threads)
        .set({ activeLeafTurnId: firstSibling.id })
        .where(eq(schema.threads.id, THREAD));
      expect(await activity()).toBe("2025-01-01T00:01:00.000000Z");
      const [stored] = await db
        .select({ leaf: schema.threads.conversationalLeafTurnId })
        .from(schema.threads)
        .where(eq(schema.threads.id, THREAD));
      expect(stored?.leaf).toBe(firstSibling.id);
    });
  });
}
