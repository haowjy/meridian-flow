/** PostgreSQL contracts for fork cutoffs, idempotency, retained bindings, and provenance. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("conversation derivation (postgres)", () => {});
else
  describe("conversation derivation (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { createBoundAgentCatalog, createDrizzleAgentRevisionStore } = await import(
      "../../packages/index.js"
    );
    const { createDrizzleEventJournalReader, createDrizzleEventJournalWriter } = await import(
      "../index.js"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { DerivedSourceNotFoundError, forkThreadAgent } = await import(
      "./derive-conversation.js"
    );
    const db = createDb(DATABASE_URL, { max: 6 });
    const repos = (
      await import("../adapters/drizzle/repositories.js")
    ).createDrizzleRepositoriesForTest(db);
    const revisions = createDrizzleAgentRevisionStore(db);
    const eventReader = createDrizzleEventJournalReader(db);
    const eventWriter = createDrizzleEventJournalWriter(db);
    const ids = THREAD_WORK_RACE;
    beforeEach(async () => resetThreadWorkRaceFixture(db));
    afterAll(() => db.close());

    async function setupSource() {
      const project = {
        id: ids.projectId,
        userId: ids.userId,
        name: "Work Lifecycle Race",
        slug: "work-lifecycle-race",
        isPersonal: false,
        systemPrompt: null,
        settings: {},
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
      const projects = {
        async findById(projectId: string) {
          return projectId === ids.projectId ? project : null;
        },
      };
      const agentCatalog = createBoundAgentCatalog({
        store: revisions,
        defaultModel: () => "gpt-4.1-mini",
        unavailableReasons: () => [],
      });
      const agent = await agentCatalog.save(ids.userId, {
        slug: `fork-agent-${crypto.randomUUID()}`,
        content: "---\nname: Writer\nmode: primary\n---\n\nWriter prompt.",
      });
      const selection = await agentCatalog.resolvePrimary(
        ids.userId,
        agent.selection,
        ids.projectId,
      );
      if (!selection.ok) throw new Error("Could not resolve fixture Agent");
      const configuration = { ...selection.configuration, model: "retained-model" };
      const invocationOverlay = {
        appendSystemPrompt: "Retained invocation note.",
        overrides: { effort: "high" as const },
      };

      const source = await repos.threads.findById(ids.threadId);
      if (!source) throw new Error("Could not find fixture source thread");
      await repos.threadWorks.addMembership(source.id, ids.noWorkId, true);
      await revisions.bindThread(
        source.id,
        selection.revision.id,
        configuration,
        invocationOverlay,
      );

      const deps = {
        threads: repos.threads,
        threadWorks: repos.threadWorks,
        turns: repos.turns,
        blocks: repos.blocks,
        threadDocuments: repos.threadDocuments,
        transaction: repos.transaction,
        projects,
        works: {
          async findNoWork() {
            return { id: ids.noWorkId } as never;
          },
        },
        workContextNotices: { async threadChanged() {} },
        agentCatalog,
        agentRevisions: revisions,
        eventWriter,
      };
      const firstTurn = await repos.turns.create({
        threadId: source.id,
        role: "user",
        origin: "writer",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      return {
        source,
        deps,
        agentCatalog,
        agent,
        selection,
        configuration,
        invocationOverlay,
        firstTurn,
      };
    }

    async function createFork(
      source: { id: string; userId: string },
      deps: Parameters<typeof forkThreadAgent>[0],
      input: { id?: string; originTurnId?: string | null } = {},
    ) {
      return forkThreadAgent(deps, {
        id: input.id ?? crypto.randomUUID(),
        threadId: source.id,
        userId: source.userId,
        originTurnId: input.originTurnId,
      });
    }

    it("hides missing and unowned source threads as not found", async () => {
      const fixture = await setupSource();
      await expect(
        forkThreadAgent(fixture.deps, {
          id: crypto.randomUUID(),
          threadId: crypto.randomUUID(),
          userId: ids.userId,
        }),
      ).rejects.toBeInstanceOf(DerivedSourceNotFoundError);
      await expect(
        forkThreadAgent(fixture.deps, {
          id: crypto.randomUUID(),
          threadId: fixture.source.id,
          userId: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(DerivedSourceNotFoundError);
    });

    it("keeps the source's retained binding after its catalog advances", async () => {
      const fixture = await setupSource();
      await fixture.agentCatalog.save(ids.userId, {
        slug: fixture.agent.slug,
        content: "---\nname: Writer\nmode: primary\n---\n\nAdvanced prompt.",
        expectedRevisionId: fixture.agent.selection.definitionRevisionId,
      });

      const { thread: fork } = await createFork(fixture.source, fixture.deps, {
        originTurnId: fixture.firstTurn.id,
      });
      expect(fork.agentDefinitionRevisionId).toBe(fixture.selection.revision.id);
      const binding = await revisions.readThreadBinding(fork.id);
      expect(binding?.revision?.id).toBe(fixture.selection.revision.id);
      expect(binding?.configuration).toEqual(fixture.configuration);
      expect(binding?.invocationOverlay).toEqual(fixture.invocationOverlay);
    });

    it("reuses repeated client IDs by the existing fork row", async () => {
      const fixture = await setupSource();
      const secondTurn = await repos.turns.create({
        threadId: fixture.source.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
        prevTurnId: fixture.firstTurn.id,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      const id = crypto.randomUUID();
      const concurrent = await Promise.all([
        createFork(fixture.source, fixture.deps, { id, originTurnId: fixture.firstTurn.id }),
        createFork(fixture.source, fixture.deps, { id, originTurnId: fixture.firstTurn.id }),
      ]);
      expect(concurrent.map((result) => result.thread.id)).toEqual([id, id]);
      expect(concurrent.filter((result) => result.created)).toHaveLength(1);
      await expect(
        createFork(fixture.source, fixture.deps, { id, originTurnId: fixture.firstTurn.id }),
      ).resolves.toMatchObject({ thread: { id }, created: false });
      await expect(
        createFork(fixture.source, fixture.deps, { id, originTurnId: secondTurn.id }),
      ).resolves.toMatchObject({ thread: { id }, created: false });

      const otherSource = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Other source",
      });
      await repos.threadWorks.addMembership(otherSource.id, ids.noWorkId, true);
      await revisions.bindThread(
        otherSource.id,
        fixture.selection.revision.id,
        fixture.selection.configuration,
        null,
      );
      const otherTurn = await repos.turns.create({
        threadId: otherSource.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await expect(
        createFork(otherSource, fixture.deps, { id, originTurnId: otherTurn.id }),
      ).resolves.toMatchObject({ thread: { id }, created: false });

      const otherOwnerId = crypto.randomUUID();
      await db.insert(schema.users).values({
        id: otherOwnerId,
        externalId: `fork-id-other-owner-${otherOwnerId}`,
        email: `fork-id-other-owner-${otherOwnerId}@test.invalid`,
      });
      await db
        .update(schema.threads)
        .set({ createdByUserId: otherOwnerId })
        .where(eq(schema.threads.id, id));
      await expect(
        createFork(fixture.source, fixture.deps, { id, originTurnId: fixture.firstTurn.id }),
      ).rejects.toMatchObject({
        name: "ForkThreadConflictError",
        message: "The requested fork ID is already in use",
      });
    });

    it("returns the row when competing sources hit the same ID insert", async () => {
      const fixture = await setupSource();
      const otherSource = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Other source",
      });
      await repos.threadWorks.addMembership(otherSource.id, ids.noWorkId, true);
      await revisions.bindThread(
        otherSource.id,
        fixture.selection.revision.id,
        fixture.configuration,
        fixture.invocationOverlay,
      );
      const otherTurn = await repos.turns.create({
        threadId: otherSource.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });

      let waitingCreators = 0;
      let releaseCreators: (() => void) | undefined;
      const bothCreating = new Promise<void>((resolve) => {
        releaseCreators = resolve;
      });
      const threads = {
        ...fixture.deps.threads,
        async createDerivedPrimary(
          input: Parameters<typeof fixture.deps.threads.createDerivedPrimary>[0],
        ) {
          waitingCreators += 1;
          if (waitingCreators === 2) releaseCreators?.();
          await bothCreating;
          return fixture.deps.threads.createDerivedPrimary(input);
        },
      };
      const deps = { ...fixture.deps, threads };
      const id = crypto.randomUUID();
      const results = await Promise.all([
        createFork(fixture.source, deps, { id, originTurnId: fixture.firstTurn.id }),
        createFork(otherSource, deps, { id, originTurnId: otherTurn.id }),
      ]);

      expect(results.map((result) => result.thread.id)).toEqual([id, id]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.filter((result) => !result.created)).toHaveLength(1);
    });

    it("returns an existing fork after its source is trashed", async () => {
      const fixture = await setupSource();
      const id = crypto.randomUUID();
      const created = await createFork(fixture.source, fixture.deps, {
        id,
        originTurnId: fixture.firstTurn.id,
      });
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, fixture.source.id));

      await expect(
        createFork(fixture.source, fixture.deps, { id, originTurnId: fixture.firstTurn.id }),
      ).resolves.toMatchObject({ thread: { id: created.thread.id }, created: false });
    });

    it("forks a fork at an inherited turn with the grandsource's exact prefix", async () => {
      const fixture = await setupSource();
      const secondTurn = await repos.turns.create({
        threadId: fixture.source.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
        prevTurnId: fixture.firstTurn.id,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      const firstFork = await createFork(fixture.source, fixture.deps, {
        originTurnId: secondTurn.id,
      });
      await repos.turns.create({
        threadId: firstFork.thread.id as never,
        role: "user",
        origin: "writer",
        status: "complete",
        prevTurnId: (await repos.turns.getLatestByThread(firstFork.thread.id as never))
          ?.id as never,
        createdAt: "2026-01-01T00:05:00.000Z",
      });
      const inheritedFork = await createFork(firstFork.thread, fixture.deps, {
        originTurnId: fixture.firstTurn.id,
      });
      const forkEvents = await eventReader.listByType(firstFork.thread.id as never, "agent.fork");
      expect(forkEvents.map((entry) => entry.payload)).toContainEqual(
        expect.objectContaining({
          type: "agent.fork",
          sourceThreadId: firstFork.thread.id,
          targetThreadId: inheritedFork.thread.id,
          originTurnId: fixture.firstTurn.id,
        }),
      );
      const directFork = await createFork(fixture.source, fixture.deps, {
        originTurnId: fixture.firstTurn.id,
      });

      expect(inheritedFork.thread.originTurnId).toBe(fixture.firstTurn.id);
      expect(
        (await repos.turns.findById(inheritedFork.thread.originTurnId as never))?.threadId,
      ).toBe(fixture.source.id);
      const load = async (thread: typeof inheritedFork.thread) => {
        const { loadThreadConversationContext } = await import("../index.js");
        const context = await loadThreadConversationContext(
          { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
          thread,
        );
        return {
          turns: context.turns.map(({ role, origin, status }) => ({ role, origin, status })),
          blocks: context.blocks.map(({ blockType, textContent, content }) => ({
            blockType,
            textContent,
            content,
          })),
        };
      };
      await expect(load(inheritedFork.thread)).resolves.toEqual(await load(directFork.thread));
    });

    it("normalizes a mid-run selection to the last settled effective turn", async () => {
      const fixture = await setupSource();
      const runningTurn = await repos.turns.create({
        threadId: fixture.source.id,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        prevTurnId: fixture.firstTurn.id,
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      const { thread: fork } = await createFork(fixture.source, fixture.deps, {
        originTurnId: runningTurn.id,
      });
      expect(fork.originTurnId).toBe(fixture.firstTurn.id);
    });

    it("stops before a streaming reply and does not inherit a queued writer turn after it", async () => {
      const fixture = await setupSource();
      const assistant = await repos.turns.create({
        threadId: fixture.source.id,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        prevTurnId: fixture.firstTurn.id,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      const queuedWriter = await repos.turns.create({
        threadId: fixture.source.id,
        role: "user",
        origin: "writer",
        status: "complete",
        prevTurnId: assistant.id,
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      const { thread: fork } = await createFork(fixture.source, fixture.deps, {
        originTurnId: queuedWriter.id,
      });

      expect(fork.originTurnId).toBe(fixture.firstTurn.id);
    });

    it.each([
      "cancelled",
      "error",
    ] as const)("accepts a %s turn as a settled cutoff", async (status) => {
      const fixture = await setupSource();
      const settledTurn = await repos.turns.create({
        threadId: fixture.source.id,
        role: "assistant",
        origin: "assistant",
        status,
        prevTurnId: fixture.firstTurn.id,
      });

      const { thread: fork } = await createFork(fixture.source, fixture.deps, {
        originTurnId: settledTurn.id,
      });

      expect(fork.originTurnId).toBe(settledTurn.id);
    });

    it("rejects a source with no settled turns", async () => {
      const fixture = await setupSource();
      await repos.turns.updateStatus(fixture.firstTurn.id, { status: "streaming" });

      await expect(createFork(fixture.source, fixture.deps)).rejects.toMatchObject({
        name: "ForkCutoffError",
        code: "no_settled_turn",
      });
    });

    it("rejects deleting a referenced turn and generically resets its full thread graph", async () => {
      const fixture = await setupSource();
      const fork = await createFork(fixture.source, fixture.deps, {
        originTurnId: fixture.firstTurn.id,
      });
      const child = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: fixture.source.id as never,
        rootThreadId: fixture.source.id as never,
        originTurnId: fixture.firstTurn.id,
        spawnDepth: 1,
      });

      await expect(
        db.transaction((tx) =>
          tx.delete(schema.turns).where(eq(schema.turns.id, fixture.firstTurn.id)),
        ),
      ).rejects.toMatchObject({
        cause: { constraint_name: "threads_origin_turn_id_turns_id_fk" },
      });
      expect(await repos.turns.findById(fixture.firstTurn.id)).not.toBeNull();

      await deleteDrizzleRows(db, [schema.turns]);

      expect(await repos.threads.findByIdIncludingDeleted(fixture.source.id as never)).toBeNull();
      expect(await repos.threads.findByIdIncludingDeleted(fork.thread.id as never)).toBeNull();
      expect(await repos.threads.findByIdIncludingDeleted(child.id as never)).toBeNull();
    });
  });
