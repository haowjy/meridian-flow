/** Compaction's two commits exercise real inbox, lease, epoch, and journal transactions. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import { createTestAgentBinding } from "./__tests__/runtime-fixtures.js";
import { createRuntimeHarness } from "./__tests__/runtime-harness.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { createTestDrizzleDelivery } from "./__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("compaction protocol", () => {});
else
  describe("compaction protocol", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    beforeEach(() => truncateDrizzleTables(db, [schema.users]));
    afterAll(() => db.close());

    async function fixture(
      options: {
        history?: string;
        child?: boolean;
        summarizer?: ReturnType<typeof scriptedSummarizer>;
        gateway?: ReturnType<typeof scriptedGateway>;
      } = {},
    ) {
      const { repos, ids } = await executionScenario(db);
      const threadId = options.child ? ids.child : ids.caller;
      const claim = createDrizzleRunClaim(db);
      const eventWriter = createDrizzleEventJournalWriter(db);
      const source = createTestAgentBinding("gpt-4.1-mini", "Write stories.", () => [threadId]);
      const binding = {
        ...source,
        async readThreadBinding(id: string) {
          const result = await source.readThreadBinding(id);
          if (result?.revision) result.revision.definition.metadata.autocompact = 2500;
          return result;
        },
      };
      const gateway = options.gateway ?? scriptedGateway();
      const summarizer = options.summarizer ?? scriptedSummarizer();
      const rig = createRuntimeHarness({
        repos,
        eventWriter,
        runClaim: claim,
        agentRevisions: binding,
        summarizer,
        gateway: {
          ...gateway,
          listModels: () => [
            {
              id: "gpt-4.1-mini",
              provider: "openai",
              displayName: "Fixture",
              contextWindow: 128000,
              maxOutputTokens: 100,
              promptCache: { kind: "automatic", ttlMs: 60000 },
              capabilities: new Set(),
            },
          ],
        },
        delivery: createTestDrizzleDelivery(db, { repos, eventWriter, runClaim: claim }),
      });
      await rig.creditLedger.grant({
        userId: ids.user,
        source: "manual",
        amountMillicredits: "1000000000",
        reason: "fixture",
      });
      const previous = (await repos.turns.listByThread(threadId)).at(-1);
      const history = await repos.turns.create({
        threadId,
        prevTurnId: previous?.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await repos.blocks.create({
        turnId: history.id,
        blockType: "text",
        sequence: 0,
        content: options.history ?? "old history ".repeat(1500),
        textContent: options.history ?? "old history ".repeat(1500),
        status: "complete",
      });
      const answer = await repos.turns.create({
        threadId,
        prevTurnId: history.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await repos.blocks.create({
        turnId: answer.id,
        blockType: "text",
        sequence: 0,
        content: "old answer",
        textContent: "old answer",
        status: "complete",
      });
      return { ...rig, threadId, gateway, summarizer, ids };
    }

    it.each([
      false,
      true,
    ])("reserves C at run start and commits B over an unchanged rebake (child=%s)", async (child) => {
      const rig = await fixture({ child });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const c = (await rig.repos.turns.listByThread(rig.threadId)).at(-1)!;
      if (c.role !== "compaction") {
        const result = await run.execute();
        throw new Error(JSON.stringify(result));
      }
      expect(c).toMatchObject({ role: "compaction", status: "pending" });
      expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(c.id);
      const initialBake = (await rig.repos.threads.findById(rig.threadId))?.initialPromptBakeId;
      if (child)
        expect(
          (await rig.repos.executionReports.findByExecution(rig.threadId, c.id))?.executionTurnId,
        ).toBe(c.id);
      const result = await run.execute();
      expect(result.status).toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.slice(-3).map((turn) => [turn.role, turn.status])).toEqual([
        ["user", "complete"],
        ["compaction", "complete"],
        ["assistant", "complete"],
      ]);
      expect((await rig.repos.turns.findById(c.id))?.promptBakeId).toBe(initialBake);
      expect(rig.summarizer.calls).toHaveLength(1);
      const thread = (await rig.repos.threads.findById(rig.threadId))!;
      const rebuilt = await assembleNextTurnContext({
        thread,
        turns: turns.slice(0, -1),
        blocks: (await rig.repos.blocks.listByThread(rig.threadId)).filter(
          (block) => block.turnId !== turns.at(-1)?.id,
        ),
        agentRevisions: rig.deps.agentRevisions,
        toolRegistry: rig.deps.toolRegistry,
        baseTools: [],
        gateway: rig.deps.gateway,
        promptBakes: rig.repos.promptBakes,
        workContext: rig.deps.workContext,
      });
      expect(JSON.stringify(rig.gateway.requests[0].messages)).toBe(
        JSON.stringify(rebuilt.generateRequest.messages),
      );
    });

    it("lands an impossible pinned request as a failed reply without C and acknowledges it", async () => {
      const rig = await fixture();
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "too big ".repeat(5000),
      });
      expect((await run.execute()).status).toBe("error");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.some((turn) => turn.role === "compaction")).toBe(false);
      expect(turns.at(-1)?.error).toBe("This message is too long for this chat's model.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });
    it.each([
      false,
      true,
    ])("orders writer and agent arrivals after C and lands the reply below both (failure=%s)", async (failure) => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      let writerId = "";
      let agentId = "";
      const summarizer = scriptedSummarizer(async ({ turnId }) => {
        expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(turnId);
        expect(await rig.runClaim.read(rig.threadId)).toMatchObject({ phase: "compacting" });
        writerId = (await rig.send(rig.threadId, "late writer")).userTurnId;
        agentId = (
          await rig.delivery.enqueue({
            threadId: rig.threadId,
            intent: "message",
            provenance: { kind: "agent", threadId: rig.ids.child },
            body: { kind: "text", text: "late agent" },
            idempotencyKey: "late-agent",
          })
        ).id;
        return failure
          ? { kind: "failed", error: new Error("summary failed"), modelResponses: [] }
          : {
              kind: "complete",
              text: "Earlier context.",
              model: "summary-model",
              modelResponses: [],
            };
      });
      rig = await fixture({ summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe(failure ? "error" : "complete");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-4);
      expect(tail.map((turn) => turn.role)).toEqual(["compaction", "user", "user", "assistant"]);
      expect(tail.slice(1, 3).map((turn) => turn.id)).toEqual([writerId, agentId]);
      expect(tail[0].status).toBe(failure ? "error" : "complete");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it("compacts at close with a pending writer message, completing A before C and B", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        onStream: async (call) => {
          if (call === 1) await rig.send(rig.threadId, "A new direction.");
        },
      });
      rig = await fixture({ history: "brief context", gateway });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("complete");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-4);
      expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
        ["assistant", "complete"],
        ["user", "complete"],
        ["compaction", "complete"],
        ["assistant", "complete"],
      ]);
      expect(rig.summarizer.calls).toHaveLength(1);
    });

    it("retries successor preparation under the lock on the third attempt without resummarizing", async () => {
      const { currentDrizzleDb } = await import("../../../shared/drizzle-transaction.js");
      const rig = await fixture();
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const render = rig.deps.workContext.renderForThread;
      let attempts = 0;
      const locked: boolean[] = [];
      rig.deps.workContext.renderForThread = async (...args) => {
        attempts++;
        locked.push(currentDrizzleDb(db) !== db);
        if (attempts < 3) await rig.send(rig.threadId, `moved leaf ${attempts}`);
        return render(...args);
      };
      expect((await run.execute()).status).toBe("complete");
      expect(attempts).toBe(3);
      expect(locked).toEqual([false, false, true]);
      expect(rig.summarizer.calls).toHaveLength(1);
    });
  });
