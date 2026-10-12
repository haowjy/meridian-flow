/** Real persistence contract for the two HTTP owner gates and shared root creation policy. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createBoundAgentCatalog, seedGeneralAgent } from "../domains/packages/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import { useComposedRuntimes } from "../test-support/composed-runtime.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../test-support/drizzle-reset.js";
import { HTTP_INTERRUPT_ENVELOPE_KEY } from "./interrupt-boundary.js";
import { createThreadForProject } from "./thread-creation.js";
import { throwThreadCreationError } from "./thread-creation-http.js";

const OWNER = "00000000-0000-4000-8000-000000000a01";
const OTHER = "00000000-0000-4000-8000-000000000a02";
const PROJECT = "00000000-0000-4000-8000-000000000a03";
const THREAD = "00000000-0000-4000-8000-000000000a04";
const WORK = "00000000-0000-4000-8000-000000000a05";
const MISSING = "00000000-0000-4000-8000-000000000a06";
const database = useRollbackTestDatabase(process.env.DATABASE_URL as string, {
  prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
});
const runtimes = useComposedRuntimes(() => database.current);

async function failure(operation: () => Promise<unknown>) {
  try {
    await operation();
    throw new Error("Expected HTTP refusal");
  } catch (error) {
    const refusal = error as {
      statusCode: number;
      data?: Record<string, unknown>;
      message: string;
    };
    expect(refusal.statusCode).toBe(404);
    return refusal.data?.[HTTP_INTERRUPT_ENVELOPE_KEY] ?? { message: refusal.message };
  }
}

beforeEach(async () => {
  const db = database.current;
  await db
    .insert(schema.users)
    .values([
      conformanceUserValues(OWNER, "deletion-owner"),
      conformanceUserValues(OTHER, "deletion-other"),
    ]);
  await db
    .insert(schema.projects)
    .values({ id: PROJECT, userId: OWNER, name: "Story", slug: "story" });
  await db.insert(schema.works).values({
    id: WORK,
    projectId: PROJECT,
    createdByUserId: OWNER,
    name: "Arc",
    slug: "arc",
  });
  await db.insert(schema.threads).values({
    id: THREAD,
    rootThreadId: THREAD,
    projectId: PROJECT,
    createdByUserId: OWNER,
    title: "Arc notes",
    kind: "primary",
    status: "idle",
  });
});

async function deleteFixture(state: "thread" | "project" | "cascade") {
  const db = database.current;
  if (state === "project") {
    await db
      .update(schema.projects)
      .set({ deletedAt: new Date() })
      .where(eq(schema.projects.id, PROJECT));
  } else {
    await db
      .update(schema.threads)
      .set({
        deletedAt: new Date(),
        deletedByWorkId: state === "cascade" ? WORK : null,
      })
      .where(eq(schema.threads.id, THREAD));
  }
}

describe.each(["snapshot", "runtime"] as const)("%s HTTP owner gate", (gate) => {
  async function fixture() {
    const { app } = await runtimes.compose();
    return (id: string, userId: string) =>
      gate === "snapshot"
        ? requireThreadOwner({ threads: app.repos.threads }, id, userId)
        : app.threadRuntime.requireOwnedThread(id, userId);
  }

  it.each([
    "thread",
    "project",
    "cascade",
  ] as const)("attests %s deletion only to the full owner", async (state) => {
    const ask = await fixture();
    await deleteFixture(state);
    expect(await failure(() => ask(THREAD, OWNER))).toEqual({
      kind: "error",
      error: {
        code: "thread_deleted",
        message: "Thread deleted",
        retryable: false,
        source: "system",
        details: { authenticatedUserId: OWNER },
      },
    });
    expect(JSON.stringify(await failure(() => ask(THREAD, OTHER)))).toBe(
      JSON.stringify(await failure(() => ask(MISSING, OTHER))),
    );
  });

  it.each([
    "live",
    "thread",
    "project",
    "cascade",
  ] as const)("conceals mismatched creators in %s rows from both users", async (state) => {
    const ask = await fixture();
    await database.current
      .update(schema.threads)
      .set({ createdByUserId: OTHER })
      .where(eq(schema.threads.id, THREAD));
    if (state !== "live") await deleteFixture(state);
    for (const user of [OWNER, OTHER]) {
      expect(JSON.stringify(await failure(() => ask(THREAD, user)))).toBe(
        JSON.stringify(await failure(() => ask(MISSING, user))),
      );
    }
  });

  it("attests a purged thread as not found and still permits a live owner", async () => {
    const ask = await fixture();
    expect((await ask(THREAD, OWNER)).id).toBe(THREAD);
    await database.current.delete(schema.threads).where(eq(schema.threads.id, THREAD));
    expect(await failure(() => ask(THREAD, OWNER))).toMatchObject({
      error: {
        code: "thread_not_found",
        details: { authenticatedUserId: OWNER },
      },
    });
  });
});

describe("root creation policy shared by POST /api/threads and POST /api/projects/:projectId/threads", () => {
  async function fixture() {
    const { app } = await runtimes.compose();
    await app.workRepo.ensureNoWork(PROJECT);
    await seedGeneralAgent(app.agentRevisions, "mock-model");
    const entry = await app.agentRevisions.readCatalogEntry(null, "general");
    if (!entry) throw new Error("Missing General");
    const deps = {
      projects: app.projectRepo,
      workRepo: app.workRepo,
      threads: app.repos.threads,
      threadWorks: app.repos.threadWorks,
      transaction: app.repos.transaction,
      agentRevisions: app.agentRevisions,
      agentCatalog: createBoundAgentCatalog({
        defaultModel: () => "mock-model",
        store: app.agentRevisions,
        unavailableReasons: () => [],
      }),
      eventSink: app.eventSink,
    };
    const args = {
      projectId: PROJECT,
      userId: OWNER,
      id: THREAD,
      agentSelection: { catalogEntryId: entry.id, definitionRevisionId: entry.selectedRevisionId },
    };
    const create = async (overrides: Partial<typeof args> = {}) => {
      try {
        return await createThreadForProject(deps, { ...args, ...overrides });
      } catch (error) {
        throwThreadCreationError(error);
      }
    };
    return { create, app };
  }

  it.each([
    "thread",
    "project",
    "cascade",
  ] as const)("attests the owner's existing %s-deleted id before project gating", async (state) => {
    const { create } = await fixture();
    await deleteFixture(state);
    expect(await failure(() => create())).toMatchObject({
      error: {
        code: "thread_deleted",
        details: { authenticatedUserId: OWNER },
      },
    });
  });

  it("answers foreign live and deleted ids identically", async () => {
    const { create, app } = await fixture();
    const foreignProject = await app.projectRepo.create({ userId: OTHER, title: "Foreign" });
    const foreign = await app.repos.threads.create({ userId: OTHER, projectId: foreignProject.id });
    const live = JSON.stringify(await failure(() => create({ id: foreign.id })));
    await database.current
      .update(schema.threads)
      .set({ deletedAt: new Date() })
      .where(eq(schema.threads.id, foreign.id));
    expect(JSON.stringify(await failure(() => create({ id: foreign.id })))).toBe(live);
    await database.current
      .update(schema.projects)
      .set({ deletedAt: new Date() })
      .where(eq(schema.projects.id, foreignProject.id));
    expect(JSON.stringify(await failure(() => create({ id: foreign.id })))).toBe(live);
  });

  it("conceals an id whose creator owns no part of its project", async () => {
    const { create } = await fixture();
    await database.current
      .update(schema.projects)
      .set({ userId: OTHER })
      .where(eq(schema.projects.id, PROJECT));
    const live = JSON.stringify(await failure(() => create()));
    await deleteFixture("thread");
    expect(JSON.stringify(await failure(() => create()))).toBe(live);
  });

  it("requires a live project for a new id and creates normally with an absent id", async () => {
    const { create } = await fixture();
    const created = await create({ id: undefined });
    expect(created.projectId).toBe(PROJECT);
    expect(created.id).not.toBe(THREAD);
    await deleteFixture("project");
    expect(await failure(() => create({ id: MISSING }))).toEqual({ message: "Project not found" });
  });
});
