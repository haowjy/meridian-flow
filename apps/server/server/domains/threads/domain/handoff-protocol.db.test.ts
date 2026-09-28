/** PostgreSQL contracts for handoff creation, seed ownership, and control endings. */

import * as http from "@meridian/contracts/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createDrizzleRunClaim } from "../../runtime/adapters/drizzle-run-claim.js";
import { createDrizzleThreadLock } from "../../runtime/adapters/drizzle-thread-lock.js";
import { createRuntimeHarness } from "../../runtime/loop/__tests__/runtime-harness.js";
import { scriptedSummarizer } from "../../runtime/loop/__tests__/scripted-summarizer.js";
import { createTestDrizzleDelivery } from "../../runtime/loop/__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "../../runtime/loop/__tests__/test-gateway.js";
import { createOrphanReportRepair } from "../../runtime/spawn/orphan-report-repair.js";
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
    const { createBoundAgentCatalog, createDrizzleAgentRevisionStore } = await import(
      "../../packages/index.js"
    );
    const { createDrizzleEventJournalReader, createDrizzleEventJournalWriter } = await import(
      "../index.js"
    );
    const { handoffThreadAgent, forkThreadAgent } = await import("./derive-conversation.js");
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
      const configuration = { ...selection.configuration, model: "gpt-4.1-mini" };
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

      const delivery = createTestDrizzleDelivery(db, { repos, eventWriter });
      const deps = {
        delivery,
        threads: repos.threads,
        threadWorks: repos.threadWorks,
        turns: repos.turns,
        promptBakes: repos.promptBakes,
        imageInclusions: repos.imageInclusions,
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
      await repos.blocks.create({
        turnId: firstTurn.id,
        blockType: "text",
        sequence: 0,
        status: "complete",
        content: { text: "Source-only transcript" },
        textContent: "Source-only transcript",
      });
      return {
        delivery,
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

    async function fixture(script?: Parameters<typeof scriptedSummarizer>[0]) {
      const base = await setupSource();
      const claim = createDrizzleRunClaim(db);
      const delivery = createTestDrizzleDelivery(db, { repos, eventWriter, runClaim: claim });
      const gateway = {
        ...scriptedGateway({ usage: { inputTokens: 100, outputTokens: 10 } }),
        listModels: () => [
          {
            id: "gpt-4.1-mini",
            provider: "openai",
            displayName: "Fixture",
            tokenizer: "o200k" as const,
            contextWindow: 128000,
            maxOutputTokens: 100,
            promptCache: { kind: "automatic" as const, ttlMs: 60000 },
            capabilities: new Set<never>(),
          },
        ],
      };
      const summarizer = scriptedSummarizer(script);
      const rig = createRuntimeHarness({
        repos,
        eventWriter,
        runClaim: claim,
        delivery,
        agentRevisions: revisions,
        gateway,
        summarizer: summarizer,
      });
      await rig.creditLedger.grant({
        userId: ids.userId,
        source: "manual",
        amountMillicredits: "100000000",
        reason: "fixture",
      });
      const input = {
        id: crypto.randomUUID(),
        threadId: base.source.id,
        userId: ids.userId,
        originTurnId: base.firstTurn.id,
        agentSelection: base.agent.selection,
      };
      const deps = { ...base.deps, delivery };
      const created = await handoffThreadAgent(deps, input);
      const thread = created.thread;
      const seed = (await repos.turns.listByThread(thread.id))[0];
      return {
        ...base,
        ...rig,
        derive: deps,
        input,
        thread,
        seed,
        created,
        gateway,
        summarizer,
        drain: async () =>
          (await rig.orchestrator.prepare({ threadId: thread.id, drain: true })).execute(),
        async settled() {
          await expect
            .poll(
              async () => ({
                claim: (await claim.read(thread.id)).kind,
                pending: (await delivery.selectPending(thread.id)).length,
                running: rig.orchestrator.getRunningTurn(thread.id) !== null,
              }),
              { timeout: 10000 },
            )
            .toEqual({ claim: "asleep", pending: 0, running: false });
          return repos.turns.listByThread(thread.id);
        },
      };
    }

    it.each([
      "complete",
      "failed",
    ] as const)("C7b settles paid %s brief rows on S without compaction metadata", async (kind) => {
      let r: Awaited<ReturnType<typeof fixture>>;
      const responseId = crypto.randomUUID();
      r = await fixture(async () => ({
        kind,
        text: "Paid brief",
        model: "gpt-4.1-mini",
        error: new Error("provider failed"),
        rejectionReason: "provider_error",
        modelResponses: [
          {
            id: responseId,
            turnId: r.seed.id,
            sequence: 0,
            model: "gpt-4.1-mini",
            provider: "openai",
            inputTokens: 200,
            outputTokens: 20,
            cacheReadTokens: 100,
            priceSource: "unknown",
            requestMessageCount: 4,
            predictedCacheState: "warm",
            predictedCacheReason: "reusable_prefix",
            requestStartedAt: new Date().toISOString(),
            finishReason: kind === "complete" ? "end_turn" : "error",
          },
        ],
        summarizer: { path: "warm", segments: 1 },
      }));
      await r.send(r.thread.id, "hi");
      await r.drain();
      const turns = await r.settled();
      expect(await repos.modelResponses.findById(responseId)).toMatchObject({
        turnId: r.seed.id,
        predictedCacheState: "warm",
        predictedCacheReason: "reusable_prefix",
        requestMessageCount: 4,
      });
      const response = await repos.modelResponses.findById(responseId);
      expect(Number(response?.costUsd)).toBeGreaterThan(0);
      expect(Number(response?.millicredits)).toBeGreaterThan(0);
      expect(turns[0]).toMatchObject({
        status: kind === "complete" ? "complete" : "error",
        metadata: { kind: "derivation_seed", summarizer: { path: "warm", segments: 1 } },
      });
      expect(turns[0].metadata).not.toHaveProperty("compactedThrough");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      const replyRows = await repos.modelResponses.listByTurn(turns.at(-1)!.id);
      expect(replyRows[0]).toMatchObject({
        predictedCacheState: "cold",
        predictedCacheReason: "no_response",
      });
      if (kind === "failed") {
        expect(turns[0].metadata).toMatchObject({ reason: "provider_error", phase: "summary" });
        const errors = await eventReader.listByType(r.thread.id, "turn.error");
        expect(errors[0].payload).toMatchObject({
          error: {
            code: "handoff_brief_failed",
            details: { reason: "provider_error", phase: "summary" },
          },
        });
        expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("No brief is available.");
      }
    });

    it("C7b briefs before a broken destination binding and fails only its reply", async () => {
      const r = await fixture();
      const read = revisions.readThreadBinding.bind(revisions);
      revisions.readThreadBinding = async (id) => {
        if (id === r.thread.id) throw new Error("destination binding unavailable");
        return read(id);
      };
      try {
        await r.send(r.thread.id, "hi");
        await r.drain();
        const turns = await r.settled();
        expect(turns[0]).toMatchObject({ id: r.seed.id, status: "complete" });
        expect(r.summarizer.calls).toHaveLength(1);
        expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "error" });
      } finally {
        revisions.readThreadBinding = read;
      }
    });

    it("C7b a due undo behind K follows the completed brief", async () => {
      const r = await fixture();
      const target = await repos.turns.create({
        threadId: r.thread.id,
        prevTurnId: r.seed.id,
        role: "compaction",
        origin: "system",
        status: "error",
      });
      await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "compaction_undo", compactionTurnId: target.id },
      });
      await r.send(r.thread.id, "hi after undo");
      await r.drain();
      const turns = await r.settled();
      const undo = turns.find(
        (t) => (t.metadata as { kind?: string } | null)?.kind === "compaction_undo",
      );
      expect(turns[0].status).toBe("complete");
      expect(undo).toMatchObject({ status: "error", metadata: { reason: "not_active" } });
      expect(undo!.position).toBeGreaterThan(r.seed.position);
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
    });

    it("C7b a successful undo behind Retry restores its bake after the new brief", async () => {
      const r = await fixture();
      let briefCalls = 0;
      r.deps.summarizer = scriptedSummarizer(async (input) => {
        if (input.instruction === "handoff_brief" && ++briefCalls === 1)
          return { kind: "failed", error: new Error("first brief failed"), modelResponses: [] };
        return {
          kind: "complete",
          text: "Continued context",
          model: "summary-model",
          modelResponses: [],
        };
      });
      await r.drain();
      await r.settled();
      await r.send(r.thread.id, "Earlier scene. ".repeat(100));
      await r.drain();
      await r.settled();
      const beforeBake = (await repos.threads.findById(r.thread.id))?.initialPromptBakeId;
      await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "compact" },
      });
      await r.drain();
      const compaction = (await r.settled()).at(-1)!;
      expect(compaction).toMatchObject({ role: "compaction", status: "complete" });
      const retry = await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "handoff_brief" },
      });
      const undo = await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "compaction_undo", compactionTurnId: compaction.id },
      });
      await r.send(r.thread.id, "hi after restored bake");
      await r.drain();
      const turns = await r.settled();
      const byControl = (id: string) =>
        turns.find(
          (t) => (t.metadata as { controlMessageId?: string } | null)?.controlMessageId === id,
        );
      const seed = byControl(retry.response.id)!;
      const marker = byControl(undo.response.id)!;
      expect(seed).toMatchObject({ role: "system", status: "complete" });
      expect(marker).toMatchObject({ status: "complete", promptBakeId: beforeBake });
      expect(marker.position).toBeGreaterThan(seed.position);
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("hi after restored bake");
      expect(briefCalls).toBe(2);
    });

    it("C7 create-or-get is idempotent and mismatched reuse conflicts", async () => {
      const r = await fixture();
      expect(r.created.created).toBe(true);
      expect(await handoffThreadAgent(r.derive, r.input)).toMatchObject({
        created: false,
        thread: { id: r.thread.id },
      });
      await expect(handoffThreadAgent(r.derive, { ...r.input, id: r.source.id })).rejects.toThrow(
        /ID.*use/,
      );
      expect(await repos.turns.listByThread(r.thread.id)).toHaveLength(1);
    });
    it("C7 route rejects null cutoff and summary", async () => {
      const input = {
        id: crypto.randomUUID(),
        originTurnId: crypto.randomUUID(),
        agentSelection: {
          catalogEntryId: crypto.randomUUID(),
          definitionRevisionId: crypto.randomUUID(),
        },
      };
      expect(http.handoffThreadRequestSchema.safeParse(input).success).toBe(true);
      expect(
        http.handoffThreadRequestSchema.safeParse({ ...input, originTurnId: null }).success,
      ).toBe(false);
      expect(
        http.handoffThreadRequestSchema.safeParse({ ...input, summary: "client text" }).success,
      ).toBe(false);
    });
    it("C7 database rejects null handoff cutoff", async () => {
      const _r = await setupSource();
      await expect(
        db.insert(schema.threads).values({
          projectId: ids.projectId,
          createdByUserId: ids.userId,
          originType: "handoff",
          originTurnId: null,
        }),
      ).rejects.toThrow();
    });
    it("C7 mid-run selection normalizes to the last settled turn", async () => {
      const r = await fixture();
      const streaming = await repos.turns.create({
        threadId: r.source.id,
        prevTurnId: r.firstTurn.id,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      const next = await handoffThreadAgent(r.derive, {
        ...r.input,
        id: crypto.randomUUID(),
        originTurnId: streaming.id,
      });
      expect(next.thread.originTurnId).toBe(r.firstTurn.id);
    });
    it("C7 S and K commit together and event has cutoff without summary", async () => {
      const r = await fixture();
      expect(r.seed).toMatchObject({ role: "system", status: "pending" });
      expect(await r.delivery.selectPending(r.thread.id)).toMatchObject([
        {
          intent: "control",
          body: { kind: "handoff_brief", seedTurnId: r.seed.id },
          idempotencyKey: r.seed.id,
        },
      ]);
      const event = (await eventReader.listByType(r.source.id, "agent.handoff"))[0];
      expect(event.payload).toMatchObject({
        originTurnId: r.firstTurn.id,
        sourceThreadId: r.source.id,
        targetThreadId: r.thread.id,
      });
      expect(event.payload).not.toHaveProperty("summary");
      const enqueue = r.derive.delivery.enqueueSeedBrief;
      r.derive.delivery.enqueueSeedBrief = async () => {
        throw new Error("rollback seed");
      };
      const id = crypto.randomUUID();
      await expect(handoffThreadAgent(r.derive, { ...r.input, id })).rejects.toThrow(
        "rollback seed",
      );
      r.derive.delivery.enqueueSeedBrief = enqueue;
      expect(await repos.threads.findById(id)).toBeNull();
    });
    it("C7 a message before briefing gives S hi B and frozen brief without source history", async () => {
      const r = await fixture();
      await r.send(r.thread.id, "hi");
      await r.drain();
      expect((await r.settled()).map((t) => [t.role, t.status])).toEqual([
        ["system", "complete"],
        ["user", "complete"],
        ["assistant", "complete"],
      ]);
      const request = JSON.stringify(r.gateway.requests.at(-1));
      expect(request).toContain("Earlier context.");
      expect(request).toContain("prior-session-context");
      expect(request).not.toContain("Source-only transcript");
      const blocks = await repos.blocks.listByTurn(r.seed.id);
      expect(blocks[0].content).toMatchObject({
        kind: "handoff-brief",
        props: { state: "available", brief: "Earlier context." },
      });
    });
    it.each([
      "drain",
      "Stop",
      "withdrawal",
    ])("C7 stale seed control releases hi through %s", async (action) => {
      const r = await fixture();
      const [control] = await r.delivery.selectPending(r.thread.id);
      await db.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, r.seed.id));
      await r.send(r.thread.id, "hi after stale seed");
      if (action === "Stop")
        expect(await r.orchestrator.cancel(r.thread.id, r.seed.id)).toBe("cancelled");
      if (action === "withdrawal")
        expect(await r.delivery.withdrawControl(r.thread.id, control.id)).toEqual({
          outcome: "withdrawn",
        });
      await r.drain();
      const turns = await r.settled();
      expect(turns[0].status).toBe("error");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(r.summarizer.calls).toHaveLength(0);
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("hi after stale seed");
    });

    it("C7 stale seed releases a due undo and its following message", async () => {
      const r = await fixture();
      await db.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, r.seed.id));
      const compaction = await repos.turns.create({
        threadId: r.thread.id,
        prevTurnId: r.seed.id,
        role: "compaction",
        origin: "system",
        status: "error",
      });
      const undo = await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "compaction_undo", compactionTurnId: compaction.id },
      });
      await r.send(r.thread.id, "hi behind undo");
      await r.drain();
      const turns = await r.settled();
      expect(turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            status: "error",
            metadata: expect.objectContaining({
              kind: "compaction_undo",
              controlMessageId: undo.response.id,
              reason: "not_active",
            }),
          }),
        ]),
      );
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(r.summarizer.calls).toHaveLength(0);
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("hi behind undo");
    });

    it.each(["stale seed", "Retry"])("C7 successful undo composes with %s", async (mode) => {
      const r = await fixture(async () => ({
        kind: "failed",
        error: new Error("brief unavailable"),
        modelResponses: [],
      }));
      const briefSummarizer = r.summarizer;
      r.deps.summarizer = scriptedSummarizer(async (input) =>
        input.instruction === "handoff_brief"
          ? briefSummarizer.summarize(input)
          : {
              kind: "complete",
              text: "Earlier context.",
              model: "summary-model",
              modelResponses: [],
            },
      );
      const [firstControl] = await r.delivery.selectPending(r.thread.id);
      await r.drain();
      await r.settled();
      await r.send(r.thread.id, "Earlier scene. ".repeat(100));
      await r.drain();
      await r.settled();
      await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "compact" },
      });
      await r.drain();
      const compacted = await r.settled();
      const initialBake = (await repos.threads.findById(r.thread.id))?.initialPromptBakeId;
      expect(initialBake).toBeTruthy();
      const compaction = compacted.at(-1)!;
      expect(compaction).toMatchObject({ role: "compaction", status: "complete" });
      if (mode === "stale seed") {
        await db
          .update(schema.threadInboxMessages)
          .set({ deliveredAt: null })
          .where(eq(schema.threadInboxMessages.id, firstControl.id));
      }
      const undo = await r.delivery.enqueueControl({
        id: crypto.randomUUID(),
        threadId: r.thread.id,
        actorId: ids.userId,
        control: { kind: "compaction_undo", compactionTurnId: compaction.id },
      });
      const retry =
        mode === "Retry"
          ? await r.delivery.enqueueControl({
              id: crypto.randomUUID(),
              threadId: r.thread.id,
              actorId: ids.userId,
              control: { kind: "handoff_brief" },
            })
          : null;
      await r.send(r.thread.id, "hi after successful undo");
      await r.drain();
      const turns = await r.settled();
      const marker = turns.find(
        (turn) =>
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId ===
          undo.response.id,
      );
      expect(marker).toMatchObject({
        role: "system",
        status: "complete",
        promptBakeId: initialBake,
      });
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("hi after successful undo");
      expect(r.summarizer.calls).toHaveLength(retry ? 2 : 1);
      if (retry) {
        const seed = turns.find(
          (turn) =>
            (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId ===
            retry.response.id,
        );
        expect(seed).toMatchObject({ role: "system", status: "error", prevTurnId: marker?.id });
      }
    });

    it.each([
      false,
      true,
    ])("C7 missing seed retires its control with queued message=%s", async (message) => {
      const r = await fixture();
      const [control] = await r.delivery.selectPending(r.thread.id);
      await db.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, r.seed.id));
      await db
        .update(schema.threadInboxMessages)
        .set({ body: { kind: "handoff_brief", seedTurnId: crypto.randomUUID() } })
        .where(eq(schema.threadInboxMessages.id, control.id));
      if (message) {
        await r.send(r.thread.id, "hi after missing seed");
        await r.drain();
        expect((await r.settled()).at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      } else {
        await expect(r.drain()).rejects.toMatchObject({ name: "NoPendingWakeError" });
        expect(await r.delivery.selectPending(r.thread.id)).toEqual([]);
      }
      expect(r.summarizer.calls).toHaveLength(0);
    });

    it("C7 a seed settled during briefing releases hi without overwriting it", async () => {
      let r: Awaited<ReturnType<typeof fixture>>;
      r = await fixture(async () => {
        await db
          .update(schema.turns)
          .set({ status: "error" })
          .where(eq(schema.turns.id, r.seed.id));
        return { kind: "complete", text: "must not persist", model: "script", modelResponses: [] };
      });
      await r.send(r.thread.id, "hi during stale brief");
      await r.drain();
      const turns = await r.settled();
      expect(turns[0].status).toBe("error");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(r.gateway.requests.at(-1))).not.toContain("must not persist");
    });

    it("C7 failed brief lets hi run with the fallback", async () => {
      const r = await fixture(async () => ({
        kind: "failed",
        error: new Error("brief failed"),
        modelResponses: [],
      }));
      await r.send(r.thread.id, "hi");
      await r.drain();
      expect((await r.settled())[0].status).toBe("error");
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("No brief is available.");
    });
    it.each([
      "before",
      "bound",
      "briefing",
    ])("C7 Stop %s cancels S and releases messages", async (when) => {
      let r: Awaited<ReturnType<typeof fixture>>;
      r = await fixture(async ({ signal }) => {
        if (when === "briefing") {
          await r.send(r.thread.id, "during briefing");
          await r.orchestrator.cancel(r.thread.id, r.seed.id);
          signal.throwIfAborted();
        }
        return { kind: "complete", text: "Brief", model: "script", modelResponses: [] };
      });
      await r.send(r.thread.id, "before binding");
      if (when === "before") {
        expect(await r.orchestrator.cancel(r.thread.id, r.seed.id)).toBe("cancelled");
        await r.drain();
      } else {
        const run = await r.orchestrator.prepare({ threadId: r.thread.id, drain: true });
        if (when === "bound") await r.orchestrator.cancel(r.thread.id, r.seed.id);
        await run.execute();
      }
      const turns = await r.settled();
      expect(turns[0].status).toBe("cancelled");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      const request = JSON.stringify(r.gateway.requests.at(-1));
      expect(request).toContain("before binding");
      if (when === "briefing") expect(request).toContain("during briefing");
    });
    it("C7 Retry appends a new seed at the leaf", async () => {
      const r = await fixture(async (_, call) =>
        call === 1
          ? { kind: "failed", error: new Error("failed"), modelResponses: [] }
          : { kind: "complete", text: "Retry brief", model: "script", modelResponses: [] },
      );
      await r.send(r.thread.id, "hi");
      await r.drain();
      await r.settled();
      const before = await repos.turns.listByThread(r.thread.id);
      const retry = {
        threadId: r.thread.id,
        actorId: ids.userId,
        id: crypto.randomUUID(),
        control: { kind: "handoff_brief" as const },
      };
      await r.delivery.enqueueControl(retry);
      await r.drain();
      const after = await r.settled();
      expect(after.slice(0, -1)).toEqual(before);
      expect(after.at(-1)).toMatchObject({
        role: "system",
        status: "complete",
        prevTurnId: before.at(-1)?.id,
      });
      expect(await r.delivery.enqueueControl(retry)).toMatchObject({ created: false });
      await expect(
        r.delivery.enqueueControl({ ...retry, id: crypto.randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it.each([false, true])("C7 scan preserves row-owned seed after crash=%s", async (crashed) => {
      const r = await fixture();
      if (crashed) {
        const lease = await r.runClaim.startExecution(r.thread.id, crypto.randomUUID());
        if (!lease) throw new Error("no lease");
        await r.delivery.adoptBatch(lease, async (selection) => ({
          value: undefined,
          turnId: r.seed.id,
          turnKind: "handoff_brief",
          messageIds: selection.control ? [selection.control.id] : [],
        }));
        await r.runClaim.release(lease);
      }
      const repair = createOrphanReportRepair({
        inbox: r.delivery,
        repos,
        eventWriter,
        authority: r.runClaim,
        threadLock: createDrizzleThreadLock(db),
        publisher: {
          async publish() {
            return "already" as const;
          },
        },
        eventSink: createInMemoryEventSink(),
      });
      await r.delivery.materializeIdle(r.thread.id);
      expect((await repos.turns.findById(r.seed.id))?.status).toBe("pending");
      await repair.sweep(100);
      expect((await repos.turns.findById(r.seed.id))?.status).toBe("pending");
      await r.drain();
      await r.settled();
      expect(await repos.turns.listByThread(r.thread.id)).toMatchObject([
        { id: r.seed.id, status: "complete" },
      ]);
      expect(r.summarizer.calls).toHaveLength(1);
      expect(await r.delivery.selectPending(r.thread.id)).toEqual([]);
    });

    it("C7 Stop wins an optimistic binding prepare without losing hi", async () => {
      const r = await fixture();
      await r.send(r.thread.id, "hi in race");
      let entered!: () => void;
      let release!: () => void;
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const list = repos.blocks.listByThread.bind(repos.blocks);
      repos.blocks.listByThread = async (...args) => {
        entered();
        await resumed;
        return list(...args);
      };
      const preparation = r.orchestrator.prepare({ threadId: r.thread.id, drain: true });
      await preparing;
      expect(await r.orchestrator.cancel(r.thread.id, r.seed.id)).toBe("cancelled");
      release();
      const run = await preparation;
      repos.blocks.listByThread = list;
      expect((await run.execute()).status).toBe("complete");
      expect((await r.settled())[0].status).toBe("cancelled");
      expect(r.summarizer.calls).toHaveLength(0);
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("hi in race");
    });

    it("C7 remote Stop after binding releases both messages", async () => {
      const remote = createDrizzleRunClaim(db, { holderId: "remote-stop" });
      let r: Awaited<ReturnType<typeof fixture>>;
      r = await fixture(async () => {
        await r.send(r.thread.id, "during remote Stop");
        expect(await remote.cancelExecution(r.thread.id, r.seed.id)).toBe(true);
        return { kind: "complete", text: "must not persist", model: "script", modelResponses: [] };
      });
      await r.send(r.thread.id, "before remote Stop");
      await r.drain();
      const turns = await r.settled();
      expect(turns[0].status).toBe("cancelled");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      const request = JSON.stringify(r.gateway.requests.at(-1));
      expect(request).toContain("before remote Stop");
      expect(request).toContain("during remote Stop");
      expect(request).not.toContain("must not persist");
    });

    it("C7 inherited cutoff records its owner and refuses a subagent", async () => {
      const r = await fixture();
      const fork = await forkThreadAgent(r.derive, {
        id: crypto.randomUUID(),
        threadId: r.source.id,
        userId: ids.userId,
        originTurnId: r.firstTurn.id,
      });
      const target = await handoffThreadAgent(r.derive, {
        ...r.input,
        id: crypto.randomUUID(),
        threadId: fork.thread.id,
      });
      const seed = (await repos.turns.listByThread(target.thread.id))[0];
      expect(seed.metadata).toMatchObject({
        sourceThreadId: r.source.id,
        cutoffTurnId: r.firstTurn.id,
      });
      const child = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: r.source.id,
        rootThreadId: r.source.id,
        originTurnId: r.firstTurn.id,
        spawnDepth: 1,
      });
      await expect(
        handoffThreadAgent(r.derive, { ...r.input, id: crypto.randomUUID(), threadId: child.id }),
      ).rejects.toThrow("subagent");
    });

    it("C7 a compact after the brief precedes the queued reply", async () => {
      const r = await fixture();
      await r.delivery.enqueueControl({
        threadId: r.thread.id,
        id: crypto.randomUUID(),
        actorId: ids.userId,
        control: { kind: "compact" },
      });
      await r.send(r.thread.id, "after two controls");
      await r.drain();
      const turns = await r.settled();
      expect(turns.map((t) => t.role)).toEqual(["system", "user", "compaction", "assistant"]);
      expect(turns.at(-1)?.status).toBe("complete");
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("after two controls");
    });

    it.each(["pending", "complete"])("C7 Retry rejects a latest %s seed", async (status) => {
      const r = await fixture();
      if (status === "complete") {
        await r.drain();
        await r.settled();
      }
      await expect(
        r.delivery.enqueueControl({
          threadId: r.thread.id,
          id: crypto.randomUUID(),
          actorId: ids.userId,
          control: { kind: "handoff_brief" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it.each([
      "error",
      "cancelled",
    ] as const)("C7 Retry after %s is idempotent and excludes another pending brief", async (status) => {
      const r = await fixture(async () => ({
        kind: "failed",
        error: new Error("failed"),
        modelResponses: [],
      }));
      if (status === "cancelled") await r.orchestrator.cancel(r.thread.id, r.seed.id);
      else {
        await r.drain();
        await r.settled();
      }
      const input = {
        threadId: r.thread.id,
        id: crypto.randomUUID(),
        actorId: ids.userId,
        control: { kind: "handoff_brief" as const },
      };
      expect(await r.delivery.enqueueControl(input)).toMatchObject({ created: true });
      expect(await r.delivery.enqueueControl(input)).toMatchObject({ created: false });
      await expect(
        r.delivery.enqueueControl({ ...input, id: crypto.randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await r.drain();
      await r.settled();
      expect(await r.delivery.enqueueControl(input)).toMatchObject({ created: false });
    });

    it.each([
      "handoff_brief",
      "compact",
    ] as const)("C7 expired %s receipt keeps its withdrawal semantics", async (kind) => {
      const r = await fixture();
      let [control] = await r.delivery.selectPending(r.thread.id);
      let turn = r.seed;
      if (kind === "compact") {
        await r.orchestrator.cancel(r.thread.id, r.seed.id);
        const id = crypto.randomUUID();
        await r.delivery.enqueueControl({
          threadId: r.thread.id,
          id,
          actorId: ids.userId,
          control: { kind },
        });
        [control] = await r.delivery.selectPending(r.thread.id);
        turn = await repos.turns.create({
          threadId: r.thread.id,
          prevTurnId: r.seed.id,
          role: "compaction",
          origin: "system",
          status: "pending",
          metadata: { trigger: "manual", controlMessageId: id },
        });
      }
      await db.insert(schema.threadRunLeases).values({
        threadId: r.thread.id,
        runId: "stalled-run",
        holderId: "stalled-holder",
        turnId: turn.id,
        adoptedMessageIds: [control.id],
        boundTurnIds: [turn.id],
        phase: kind === "compact" ? "compacting" : "briefing",
        expiresAt: new Date(0),
      });
      expect(await r.delivery.withdrawControl(r.thread.id, control.id)).toEqual({
        outcome: kind === "compact" ? "stopping" : "withdrawn",
      });
      if (kind === "compact") {
        expect(await r.delivery.selectPending(r.thread.id)).toEqual([]);
        const [lease] = await db
          .select()
          .from(schema.threadRunLeases)
          .where(eq(schema.threadRunLeases.threadId, r.thread.id));
        expect(lease.cancelRequested).toBe(true);
        await r.send(r.thread.id, "hi after dead owner withdrawal");
        await r.drain();
        const turns = await r.settled();
        expect(turns.filter((turn) => turn.role === "compaction")).toHaveLength(1);
        expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      } else {
        expect(await r.delivery.selectPending(r.thread.id)).toEqual([]);
        expect((await repos.turns.findById(turn.id))?.status).toBe("cancelled");
      }
    });

    it("C7 Stop after an expired briefing lease retires the row-owned seed", async () => {
      const r = await fixture();
      const pending = await r.delivery.selectPending(r.thread.id);
      await db.insert(schema.threadRunLeases).values({
        threadId: r.thread.id,
        runId: "dead-run",
        holderId: "dead-holder",
        turnId: r.seed.id,
        adoptedMessageIds: [pending[0].id],
        boundTurnIds: [r.seed.id],
        phase: "briefing",
        expiresAt: new Date(0),
      });
      expect(await r.orchestrator.cancel(r.thread.id, r.seed.id)).toBe("cancelled");
      expect((await repos.turns.findById(r.seed.id))?.status).toBe("cancelled");
      expect(await r.delivery.selectPending(r.thread.id)).toEqual([]);
    });

    it("C7 same-Agent handoff keeps the acted-on current bake, not the cutoff bake", async () => {
      const r = await fixture();
      const { hashPromptBakeContent } = await import("./prompt-bake-hash.js");
      const content = {
        composedSystemPrompt: "Later source epoch",
        bakedSkillSlugs: [],
        bakedTools: [],
      };
      const bake = await repos.promptBakes.create({
        ownerThreadId: r.source.id,
        ...content,
        contentHash: hashPromptBakeContent(content),
      });
      await repos.turns.create({
        threadId: r.source.id,
        prevTurnId: r.firstTurn.id,
        role: "system",
        origin: "system",
        status: "complete",
        promptBakeId: bake.id,
      });
      const result = await handoffThreadAgent(r.derive, { ...r.input, id: crypto.randomUUID() });
      expect(result.thread.initialPromptBakeId).toBe(bake.id);
    });

    it("C7 withdrawal cancels the first seed and hi still runs", async () => {
      const r = await fixture();
      const pending = await r.delivery.selectPending(r.thread.id);
      await r.send(r.thread.id, "hi after withdrawal");
      expect(await r.delivery.withdrawControl(r.thread.id, pending[0].id)).toEqual({
        outcome: "withdrawn",
      });
      await r.drain();
      expect((await r.settled())[0].status).toBe("cancelled");
      expect(JSON.stringify(r.gateway.requests.at(-1))).toContain("hi after withdrawal");
    });
  });
