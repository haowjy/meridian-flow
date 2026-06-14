import { randomUUID } from "node:crypto";
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "./connection";
import { createDrizzleEventJournal } from "./event-journal";
import { eventJournal, projects, threads, works } from "./schema";

const databaseUrl = process.env.DATABASE_URL;
const testUserId = process.env.TEST_USER_ID;
const testUserEmail = process.env.TEST_USER_EMAIL ?? "test@meridian.dev";

function assertSafeTestDatabase(): void {
  if (!databaseUrl) {
    return;
  }
  if (process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") {
    return;
  }
  if (!databaseUrl.includes("127.0.0.1:54422")) {
    throw new Error(
      "Refusing event journal tests: DATABASE_URL must be local Supabase (127.0.0.1:54422) or set TEST_DB_ALLOW_DESTRUCTIVE=1",
    );
  }
}

async function resolveTestUserId(): Promise<UserId> {
  if (testUserId) return testUserId as UserId;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id::text
      FROM auth.users
      WHERE email = ${testUserEmail}
      LIMIT 1
    `;
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(`Test user ${testUserEmail} not found; run pnpm bootstrap first`);
    }
    return id as UserId;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!databaseUrl)("event journal", () => {
  let db: Database;
  let projectId: ProjectId;
  let workId: WorkId;
  let threadId: ThreadId;
  let threadIds: ThreadId[];
  let userId: UserId;

  beforeEach(async () => {
    assertSafeTestDatabase();
    db = createDb(databaseUrl as string);
    userId = await resolveTestUserId();
    projectId = randomUUID() as ProjectId;
    workId = randomUUID() as WorkId;
    threadId = randomUUID() as ThreadId;
    threadIds = [threadId];

    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Event journal test",
      slug: `event-journal-${randomUUID()}`,
    });
    await db.insert(works).values({
      id: workId,
      projectId,
      createdByUserId: userId,
      title: "Event journal test work",
    });
    await db.insert(threads).values({
      id: threadId,
      projectId,
      workId,
      createdByUserId: userId,
      title: "Event journal test thread",
    });
  });

  afterEach(async () => {
    await db.delete(eventJournal).where(inArray(eventJournal.threadId, threadIds));
    await db.delete(threads).where(inArray(threads.id, threadIds));
    await db.delete(works).where(eq(works.id, workId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.close();
  });

  async function createThread(title: string): Promise<ThreadId> {
    const id = randomUUID() as ThreadId;
    threadIds.push(id);
    await db.insert(threads).values({
      id,
      projectId,
      workId,
      createdByUserId: userId,
      title,
    });
    return id;
  }

  function expectedSeqs(count: number): string[] {
    return Array.from({ length: count }, (_, index) => (index + 1).toString());
  }

  function sortSeqs(seqs: string[]): string[] {
    return [...seqs].sort((left, right) => Number(left) - Number(right));
  }

  it("appends with per-thread seq and reads after a cursor", async () => {
    const journal = createDrizzleEventJournal(db);

    const firstSeq = await journal.append({
      threadId,
      eventType: "thread.created",
      payload: { message: "first" },
    });
    const secondSeq = await journal.append({
      threadId,
      eventType: "stream.delta",
      payload: { message: "second" },
    });

    expect(firstSeq).toBe("1");
    expect(secondSeq).toBe("2");

    const all = await journal.readAfter(threadId, "0");
    expect(all.map((event) => event.seq)).toEqual(["1", "2"]);
    expect(all.map((event) => event.payload)).toEqual([
      { message: "first" },
      { message: "second" },
    ]);

    const afterFirst = await journal.readAfter(threadId, "1");
    expect(afterFirst.map((event) => event.seq)).toEqual(["2"]);
    expect(afterFirst[0]?.payload).toEqual({ message: "second" });

    await expect(journal.headSeq(threadId)).resolves.toBe("2");
  });

  it("preserves per-thread sequence integrity under concurrent appends", async () => {
    const journal = createDrizzleEventJournal(db);
    const count = 12;

    const seqs = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        journal.append({
          threadId,
          eventType: "stream.delta",
          payload: { index },
        }),
      ),
    );

    expect(sortSeqs(seqs)).toEqual(expectedSeqs(count));

    const events = await journal.readAfter(threadId, "0");
    expect(events.map((event) => event.seq)).toEqual(expectedSeqs(count));
    await expect(journal.headSeq(threadId)).resolves.toBe(count.toString());
  });

  it("keeps sequence counters isolated across threads", async () => {
    const otherThreadId = await createThread("Event journal test sibling thread");
    const journal = createDrizzleEventJournal(db);

    await Promise.all([
      ...Array.from({ length: 3 }, (_, index) =>
        journal.append({
          threadId,
          eventType: "stream.delta",
          payload: { thread: "first", index },
        }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        journal.append({
          threadId: otherThreadId,
          eventType: "stream.delta",
          payload: { thread: "second", index },
        }),
      ),
    ]);

    const firstEvents = await journal.readAfter(threadId, "0");
    const secondEvents = await journal.readAfter(otherThreadId, "0");

    expect(firstEvents.map((event) => event.seq)).toEqual(expectedSeqs(3));
    expect(secondEvents.map((event) => event.seq)).toEqual(expectedSeqs(4));
    expect(firstEvents.map((event) => (event.payload as { thread: string }).thread)).toEqual([
      "first",
      "first",
      "first",
    ]);
    expect(secondEvents.map((event) => (event.payload as { thread: string }).thread)).toEqual([
      "second",
      "second",
      "second",
      "second",
    ]);
    await expect(journal.headSeq(threadId)).resolves.toBe("3");
    await expect(journal.headSeq(otherThreadId)).resolves.toBe("4");
  });
});
