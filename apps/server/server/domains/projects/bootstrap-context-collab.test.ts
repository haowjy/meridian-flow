import { randomUUID } from "node:crypto";
import type { TurnId, UserId } from "@meridian/contracts/runtime";
import {
  createDb,
  type Database,
  documents,
  documentYjsUpdates,
  projects,
  threadDocuments,
  threads,
  turns,
  works,
} from "@meridian/database";
import { desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentSyncService } from "../collab/index.js";
import { createProductionContextPortFactory } from "../context/index.js";
import { createDrizzleProjectRepository, DEFAULT_BOOTSTRAP_URI } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const testUserId = process.env.TEST_USER_ID;
const testUserEmail = process.env.TEST_USER_EMAIL ?? "test@meridian.dev";

function assertSafeTestDatabase(): void {
  if (!databaseUrl || process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") return;
  if (!databaseUrl.includes("127.0.0.1:54422")) {
    throw new Error(
      "Refusing Phase 4 server tests: DATABASE_URL must be local Supabase (127.0.0.1:54422) or set TEST_DB_ALLOW_DESTRUCTIVE=1",
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
    if (!id) throw new Error(`Test user ${testUserEmail} not found; run pnpm bootstrap first`);
    return id as UserId;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!databaseUrl)("Phase 4 bootstrap/context/collab", () => {
  let db: Database;
  let userId: UserId;

  beforeEach(async () => {
    assertSafeTestDatabase();
    db = createDb(databaseUrl as string);
    userId = await resolveTestUserId();
  });

  afterEach(async () => {
    await db.close();
  });

  it("bootstraps an idempotent project/work/thread/document graph", async () => {
    const repository = createDrizzleProjectRepository(db);

    const first = await repository.ensureDefaultBootstrap(userId);
    const second = await repository.ensureDefaultBootstrap(userId);

    expect(second).toEqual(first);

    const [project] = await db.select().from(projects).where(eq(projects.id, first.projectId));
    const [work] = await db.select().from(works).where(eq(works.id, first.workId));
    const [thread] = await db.select().from(threads).where(eq(threads.id, first.threadId));
    const [document] = await db.select().from(documents).where(eq(documents.id, first.documentId));
    const [threadDocument] = await db
      .select()
      .from(threadDocuments)
      .where(eq(threadDocuments.threadId, first.threadId));

    expect(project?.userId).toBe(userId);
    expect(work?.projectId).toBe(first.projectId);
    expect(work?.createdByUserId).toBe(userId);
    expect(thread?.workId).toBe(first.workId);
    expect(thread?.projectId).toBe(first.projectId);
    expect(thread?.currentAgentId).toBe(first.agentDefinitionId);
    expect(document?.contextSourceId).toBe(first.contextSourceId);
    expect(threadDocument?.documentId).toBe(first.documentId);
    expect(threadDocument?.relationship).toBe("editing");
  });

  it("writes through ContextPort and appends agent-attributed Yjs update rows", async () => {
    const bootstrap = await createDrizzleProjectRepository(db).ensureDefaultBootstrap(userId);
    const [latestTurn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.threadId, bootstrap.threadId))
      .orderBy(desc(turns.createdAt))
      .limit(1);
    const actorTurnId = randomUUID() as TurnId;
    if (latestTurn) {
      await db
        .update(threads)
        .set({ activeLeafTurnId: null })
        .where(eq(threads.id, bootstrap.threadId));
    }
    await db.insert(turns).values({
      id: actorTurnId,
      threadId: bootstrap.threadId,
      parentTurnId: latestTurn?.id ?? null,
      agentDefinitionId: bootstrap.agentDefinitionId,
      role: "assistant",
      status: "complete",
      completedAt: new Date(),
    });
    await db
      .update(threads)
      .set({ activeLeafTurnId: actorTurnId })
      .where(eq(threads.id, bootstrap.threadId));

    const documentSync = createDocumentSyncService({ db });
    const contextPorts = createProductionContextPortFactory({ db, documentSync });
    const markdown = `# Chapter 1\n\nPhase 4 context write ${randomUUID()}\n`;

    const result = await contextPorts
      .forThread({ threadId: bootstrap.threadId, userId })
      .writeDocument({
        uri: DEFAULT_BOOTSTRAP_URI,
        markdown,
        origin: { type: "agent", actorTurnId },
      });

    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, bootstrap.documentId));
    const [update] = await db
      .select()
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.id, result.updateSeq));

    expect(document?.markdownProjection).toBe(markdown);
    expect(update?.documentId).toBe(bootstrap.documentId);
    expect(update?.originType).toBe("agent");
    expect(update?.actorTurnId).toBe(actorTurnId);
    expect(update?.updateData.byteLength).toBeGreaterThan(0);
  });
});
