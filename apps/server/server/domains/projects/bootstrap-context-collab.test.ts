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
  threadWorks,
  turns,
  works,
} from "@meridian/database";
import {
  assertLocalSupabaseOrExplicitAllow,
  DB_TEST_FIXTURE_USER_ID_PRIMARY,
  resolveDbTestFixtureUserId,
} from "@meridian/database/__test-support__/db-fixtures";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentSyncService } from "../collab/index.js";
import { createProductionUnifiedContextPortFactory } from "../context/index.js";
import { MANUSCRIPT_URI } from "../context/manuscript-uri.js";
import { createDrizzleProjectBootstrapRepository } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

describe.skipIf(!runDbTests || !databaseUrl)("Phase 4 bootstrap/context/collab", () => {
  let db: Database;
  let userId: UserId;

  beforeEach(async () => {
    assertLocalSupabaseOrExplicitAllow(databaseUrl);
    db = createDb(databaseUrl as string);
    userId = (await resolveDbTestFixtureUserId(databaseUrl as string, {
      fixtureUserId: DB_TEST_FIXTURE_USER_ID_PRIMARY,
      suite: "bootstrap-context-collab",
    })) as UserId;
  });

  afterEach(async () => {
    await db.close();
  });

  it("bootstraps an idempotent project/work/thread/document graph", async () => {
    const repository = createDrizzleProjectBootstrapRepository(db);

    const first = await repository.ensureDefaultBootstrap(userId);
    const second = await repository.ensureDefaultBootstrap(userId);

    expect(second).toEqual(first);

    const [project] = await db.select().from(projects).where(eq(projects.id, first.projectId));
    const [work] = await db.select().from(works).where(eq(works.id, first.workId));
    const [thread] = await db.select().from(threads).where(eq(threads.id, first.threadId));
    const [membership] = await db
      .select()
      .from(threadWorks)
      .where(eq(threadWorks.threadId, first.threadId));
    const [document] = await db.select().from(documents).where(eq(documents.id, first.documentId));
    const [threadDocument] = await db
      .select()
      .from(threadDocuments)
      .where(eq(threadDocuments.threadId, first.threadId));

    expect(project?.userId).toBe(userId);
    expect(work?.projectId).toBe(first.projectId);
    expect(work?.createdByUserId).toBe(userId);
    expect(membership?.workId).toBe(first.workId);
    expect(membership?.isPrimary).toBe(true);
    expect(thread?.projectId).toBe(first.projectId);
    expect(thread?.currentAgentId).toBe("writer");
    expect(document?.contextSourceId).toBe(first.contextSourceId);
    expect(threadDocument?.documentId).toBe(first.documentId);
    expect(threadDocument?.relationship).toBe("editing");
  });

  it("writes through ContextPort and appends agent-attributed Yjs update rows", async () => {
    const bootstrap =
      await createDrizzleProjectBootstrapRepository(db).ensureDefaultBootstrap(userId);
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
    const contextPorts = createProductionUnifiedContextPortFactory({ db, documentSync });
    const markdown = `# Chapter 1\n\nPhase 4 context write ${randomUUID()}\n`;

    const resolution = await (async () => {
      const { resolveThreadContext, contextPortForThread } = await import(
        "../context/context-port-resolution.js"
      );
      const { createDrizzleRepositories } = await import("../threads/adapters/drizzle/index.js");
      const repos = createDrizzleRepositories(db);
      const resolved = await resolveThreadContext(
        { threads: repos.threads, threadWorks: repos.threadWorks },
        bootstrap.threadId,
      );
      if (!resolved) throw new Error("thread not found");
      return contextPortForThread(contextPorts, resolved);
    })();

    const result = await resolution.write(MANUSCRIPT_URI, markdown, {
      origin: {
        type: "agent",
        agentSlug: "writer",
        threadId: bootstrap.threadId,
        turnId: actorTurnId,
      },
    });
    if (!result.ok) {
      const message =
        result.error.code === "io_error"
          ? result.error.message
          : result.error.code === "invalid_uri"
            ? result.error.reason
            : "write failed";
      throw new Error(message);
    }

    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, bootstrap.documentId));
    const [update] = await db
      .select()
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, bootstrap.documentId))
      .orderBy(desc(documentYjsUpdates.id))
      .limit(1);

    expect(document?.markdownProjection).toBe(markdown.trimEnd());
    expect(update?.documentId).toBe(bootstrap.documentId);
    expect(update?.originType).toBe("agent");
    expect(update?.actorTurnId).toBe(actorTurnId);
    expect(update?.updateData.byteLength).toBeGreaterThan(0);
  });
});
