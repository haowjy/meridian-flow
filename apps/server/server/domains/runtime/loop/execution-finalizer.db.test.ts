/** PostgreSQL terminal A: turn, report, journal, and publication share one commit. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-000000000ad1",
  project: "00000000-0000-4000-8000-000000000ad2",
  parent: "00000000-0000-4000-8000-000000000ad3" as ThreadId,
  child: "00000000-0000-4000-8000-000000000ad4" as ThreadId,
  parentTurn: "00000000-0000-4000-8000-000000000ad5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-000000000ad6" as TurnId,
  execution: "00000000-0000-4000-8000-000000000ad7" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("execution terminal A (postgres)", () => {});
else
  describe("execution terminal A (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createDrizzleEventJournalWriter, createDrizzleEventJournalReader } = await import(
      "../../threads/index.js"
    );
    const { finalizeExecution } = await import("./execution-finalizer.js");

    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const eventWriter = createDrizzleEventJournalWriter(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(ids.user, "terminal-a"));
      await db.insert(schema.projects).values({
        id: ids.project,
        userId: ids.user,
        name: "Terminal A",
        slug: "terminal-a",
      });
      await db.insert(schema.threads).values([
        { id: ids.parent, projectId: ids.project, createdByUserId: ids.user, ref: "c1" },
        {
          id: ids.child,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p1",
          kind: "subagent",
          parentThreadId: ids.parent,
          rootThreadId: ids.parent,
          originTurnId: ids.parentTurn,
          originType: "spawn",
          spawnStatus: "running",
        },
      ]);
      await db.insert(schema.turns).values([
        { id: ids.parentTurn, threadId: ids.parent, role: "assistant", status: "complete" },
        { id: ids.childUserTurn, threadId: ids.child, role: "user", status: "complete" },
        {
          id: ids.execution,
          threadId: ids.child,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          status: "streaming",
        },
      ]);
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: ids.parent,
        callerTurnId: ids.parentTurn,
        toolCallId: "spawn-1",
        cardBlockId: null,
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("cancels only the adopted inbox batch atomically, leaving later messages for a new turn", async () => {
      const { createDrizzleInbox } = await import("../adapters/drizzle-inbox.js");
      const { createDrizzleThreadLock } = await import("../adapters/drizzle-thread-lock.js");
      const { createDrizzleRunAuthority } = await import(
        "../adapters/drizzle-thread-run-ownership.js"
      );
      const { createOrchestrator } = await import("./orchestrator.js");
      const { createTestOrchestratorDeps } = await import("./__tests__/test-orchestrator-deps.js");
      const inbox = createDrizzleInbox(db);
      const authority = createDrizzleRunAuthority(db);
      const enqueue = (text: string) =>
        inbox.enqueue({
          threadId: ids.parent,
          intent: "message",
          provenance: { kind: "writer", actorId: ids.user },
          body: { kind: "text", text },
          idempotencyKey: text,
        });
      const stopped = await enqueue("stopped request");
      {
        const controller = new AbortController();
        const orchestrator = createOrchestrator(
          createTestOrchestratorDeps({
            repos,
            eventWriter,
            inbox,
            runAuthority: authority,
            threadLock: createDrizzleThreadLock(db),
            boundThreads: () => [ids.parent],
          }),
        );
        const handle = await orchestrator.prepare({
          threadId: ids.parent,
          drain: true,
          signal: controller.signal,
        });
        const later = await enqueue("later request");
        controller.abort();
        expect((await inbox.listPending(ids.parent)).map((row) => row.id)).toEqual([
          stopped.id,
          later.id,
        ]);
        expect((await handle.execute()).status).toBe("cancelled");
        expect((await repos.turns.findById(handle.assistantTurnId))?.status).toBe("cancelled");
        expect((await inbox.listPending(ids.parent)).map((row) => row.id)).toEqual([later.id]);
        expect(await authority.holder(ids.parent)).toBeNull();
        const next = await orchestrator.prepare({ threadId: ids.parent, drain: true });
        expect(next.userTurnId).toBe(later.id);
        expect(next.assistantTurnId).not.toBe(handle.assistantTurnId);
        await next.execute();
      }
    });

    it.each([
      "finish",
      "tool",
      "cancel",
      "rollback",
    ] as const)("splits an ordered mixed batch at %s with one lease and report", async (boundary) => {
      const { createDrizzleInbox } = await import("../adapters/drizzle-inbox.js");
      const { createDrizzleThreadLock } = await import("../adapters/drizzle-thread-lock.js");
      const { createDrizzleRunAuthority } = await import(
        "../adapters/drizzle-thread-run-ownership.js"
      );
      const { createThreadedInbox } = await import("./threaded-inbox.js");
      const { persistWriterEnqueue } = await import("./writer-enqueue.js");
      const { createOrchestrator } = await import("./orchestrator.js");
      const { createTestOrchestratorDeps } = await import("./__tests__/test-orchestrator-deps.js");
      const { readThreadReport } = await import("../spawn/read-thread-report.js");
      const { readPendingInbox } = await import("./pending-inbox.js");
      const { createInertGateway } = await import("./__tests__/test-gateway.js");
      const inbox = createDrizzleInbox(db);
      const authority = createDrizzleRunAuthority(db);
      const threadLock = createDrizzleThreadLock(db);
      const producer = createThreadedInbox({
        inbox,
        threadLock,
        runStarter: { async start() {} },
        schedulePostCommit() {},
      });
      const controller = new AbortController();
      const requests: import("../gateway/index.js").GenerateRequest[] = [];
      const messageIds: string[] = [];
      let selector: TurnId;
      let terminal: TurnId | null = null;
      let splitState: unknown;
      const deps = createTestOrchestratorDeps({
        repos,
        eventWriter: {
          async appendEvent(threadId, event) {
            if (
              boundary === "rollback" &&
              selector &&
              event.type === "turn.created" &&
              event.turn.role === "assistant" &&
              event.turn.id !== selector
            )
              throw new Error("split journal failed");
            return eventWriter.appendEvent(threadId, event);
          },
        },
        inbox,
        runAuthority: authority,
        threadLock,
        boundThreads: () => [ids.child],
        gateway: {
          ...createInertGateway("gpt-4.1-mini"),
          async *stream(request) {
            requests.push(request);
            if (requests.length === 1) {
              const child = await producer.enqueue({
                threadId: ids.child,
                intent: "message",
                provenance: {
                  kind: "child",
                  threadId: ids.parent,
                  reportId: ids.parentTurn,
                },
                body: { kind: "text", text: "child notification" },
                idempotencyKey: "child",
              });
              messageIds.push(child.id);
              const writerId = crypto.randomUUID();
              await persistWriterEnqueue({
                persistence: { repos, eventWriter },
                hub: {
                  async headSeq() {
                    return 0n;
                  },
                },
                inbox,
                threadedInbox: producer,
                workContextDelivery: { async beforeTurn() {} },
                threadId: ids.child,
                userTurnId: writerId,
                userBlocks: [{ type: "text", text: "writer steer" }],
                draft: {
                  id: writerId,
                  threadId: ids.child,
                  intent: "message",
                  provenance: { kind: "writer", actorId: ids.user },
                  body: { kind: "text", text: "writer steer" },
                  idempotencyKey: "writer",
                },
                settle: async () => true,
              });
              messageIds.push(writerId);
              // Replay cannot duplicate the queue row or its eventual turn.
              await producer.enqueue({
                threadId: ids.child,
                intent: "message",
                provenance: { kind: "writer", actorId: ids.user },
                body: { kind: "text", text: "writer steer" },
                idempotencyKey: "writer",
              });
            } else {
              terminal = await authority.readRunningTurnId(ids.child);
              splitState = {
                run: await authority.holder(ids.child),
                oldCancel: await authority.cancel(ids.child, selector),
                report: await repos.executionReports.findByExecution(ids.child, selector),
                lookup: await readThreadReport({
                  callerThreadId: ids.parent,
                  ref: "p1",
                  execution: selector,
                  repos,
                  runningTurn: authority,
                }),
                pending: await readPendingInbox(inbox, ids.child),
              };
            }
            yield {
              type: "end",
              result: {
                content: [
                  { type: "text", text: requests.length === 1 ? "before steer" : "after steer" },
                ],
                toolCalls:
                  requests.length === 1 && boundary === "tool"
                    ? [{ id: "tool-1", name: "unregistered", arguments: {} }]
                    : [],
                finishReason:
                  requests.length === 1 && boundary === "tool" ? "tool_use" : "end_turn",
                usage: { inputTokens: 1000000, outputTokens: 1000000 },
                provider: "openai",
                model: "gpt-4.1-mini",
              },
            };
          },
        },
      });
      await deps.creditLedger.grant({
        userId: ids.user,
        source: "manual",
        amountMillicredits: "1000000",
        reason: "split",
      });
      {
        const run = await createOrchestrator(deps).prepare({
          threadId: ids.child,
          userText: "start",
          signal: controller.signal,
          onAssistantTurnChanged: (id) => {
            terminal = id;
            if (boundary === "cancel") controller.abort();
          },
        });
        selector = run.assistantTurnId;
        const outcome = await run.execute();
        const events = (await createDrizzleEventJournalReader(db).listByThread(ids.child)).map(
          (entry) => entry.payload,
        );
        expect(outcome.status).toBe(
          boundary === "cancel" ? "cancelled" : boundary === "rollback" ? "error" : "complete",
        );
        const turns = await repos.turns.listByThread(ids.child);
        if (boundary === "rollback") {
          expect(terminal).toBeNull();
          expect((await repos.turns.findById(selector))?.status).toBe("error");
          expect(await repos.executionReports.findByExecution(ids.child, selector)).toMatchObject({
            terminalAssistantTurnId: selector,
            outcome: "failed",
            summary: "before steer",
          });
          expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
          expect((await inbox.listPending(ids.child)).map((message) => message.id)).toEqual(
            messageIds,
          );
          expect(await authority.holder(ids.child)).toBeNull();
          return;
        }
        const b = turns.find((turn) => turn.id === terminal);
        if (!terminal) throw new Error("expected split terminal turn");
        expect(b?.parentTurnId).toBe(messageIds[1]);
        expect(turns.find((turn) => turn.id === messageIds[1])?.parentTurnId).toBe(messageIds[0]);
        expect(turns.find((turn) => turn.id === messageIds[0])?.parentTurnId).toBe(selector);
        expect(turns.filter((turn) => messageIds.includes(turn.id))).toHaveLength(2);
        expect((await repos.turns.findById(selector))?.status).toBe("complete");
        const report = await repos.executionReports.findByExecution(ids.child, selector);
        expect(report).toMatchObject({
          assistantTurnId: selector,
          terminalAssistantTurnId: terminal,
          outcome: boundary === "cancel" ? "cancelled" : "succeeded",
          summary: boundary === "cancel" ? "" : "after steer",
        });
        expect(await repos.executionReports.findByExecution(ids.child, terminal)).toBeNull();
        const costs = await Promise.all(
          [selector, terminal].map((id) => repos.modelResponses.listByTurn(id)),
        );
        expect(report?.costMillicredits).toBe(
          costs.flat().reduce((sum, response) => sum + Number(response.millicredits), 0),
        );
        expect(await inbox.listPending(ids.child)).toEqual([]);
        expect(await authority.holder(ids.child)).toBeNull();
        expect(events.filter((event) => event.type === "turn.completed").length).toBe(
          boundary === "cancel" ? 1 : 2,
        );
        if (boundary !== "cancel") {
          expect(splitState).toMatchObject({
            run: run.runId,
            oldCancel: false,
            report: { outcome: null, terminalAssistantTurnId: null },
            lookup: { status: "not_ready" },
            pending: {
              items: [{ deliveryState: "awaiting_run" }, { deliveryState: "awaiting_run" }],
            },
          });
          const text = JSON.stringify(requests[1]?.messages);
          expect(text.indexOf("before steer")).toBeLessThan(text.indexOf("child notification"));
          expect(text.indexOf("child notification")).toBeLessThan(text.indexOf("writer steer"));
        }
      }
    });

    it("rolls terminal turn and report obligation back together, then retries idempotently", async () => {
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
        summary: "candidate",
      });
      await expect(
        repos.transaction(async () => {
          await finalizeExecution(
            { repos, eventWriter },
            {
              threadId: ids.child,
              assistantTurnId: ids.execution,
              cause: { kind: "failed", reason: "budget", error: "budget exhausted" },
            },
          );
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");
      expect((await repos.turns.findById(ids.execution))?.status).toBe("streaming");
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toMatchObject({
        capture: { summary: "candidate" },
        outcome: null,
        publication: "none",
      });

      const first = await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "failed", reason: "budget", error: "budget exhausted" },
        },
      );
      expect(first.events.map((event) => event.type)).toEqual(["turn.error"]);
      expect(first.report).toMatchObject({
        outcome: "failed",
        source: "return_result",
        summary: "candidate",
        publication: "pending",
      });
      const replay = await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "failed", reason: "budget", error: "budget exhausted" },
        },
      );
      expect(replay.events).toEqual([]);
      expect(replay.report).toMatchObject({ outcome: "failed", publication: "pending" });
    });

    it("selects ordered public blocks of the final persisted response and its own accounting", async () => {
      const earlier = await repos.modelResponses.create({
        turnId: ids.execution,
        sequence: 0,
        provider: "test",
        model: "test-model",
        priceSource: "unknown",
        millicredits: "3",
      });
      const final = await repos.modelResponses.create({
        turnId: ids.execution,
        sequence: 1,
        provider: "test",
        model: "test-model",
        priceSource: "unknown",
        millicredits: "4",
      });
      await repos.blocks.create({
        turnId: ids.execution,
        responseId: earlier.row.id,
        blockType: "text",
        sequence: 1,
        content: "older public text",
      });
      await repos.blocks.create({
        turnId: ids.execution,
        responseId: final.row.id,
        blockType: "text",
        sequence: 4,
        content: "part two",
      });
      await repos.blocks.create({
        turnId: ids.execution,
        responseId: final.row.id,
        blockType: "text",
        sequence: 3,
        content: "final ",
      });
      const terminal = await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "success", finishReason: "end_turn" },
        },
      );
      expect(terminal.report).toMatchObject({
        outcome: "succeeded",
        source: "final_assistant",
        summary: "final part two",
        costMillicredits: 7,
      });
    });

    it("does not borrow older text when the last persisted response has no public text", async () => {
      const earlier = await repos.modelResponses.create({
        turnId: ids.execution,
        sequence: 0,
        provider: "test",
        model: "test-model",
        priceSource: "unknown",
      });
      await repos.modelResponses.create({
        turnId: ids.execution,
        sequence: 1,
        provider: "test",
        model: "test-model",
        priceSource: "unknown",
      });
      await repos.blocks.create({
        turnId: ids.execution,
        responseId: earlier.row.id,
        blockType: "text",
        sequence: 1,
        content: "older public text",
      });
      const terminal = await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "success", finishReason: "end_turn" },
        },
      );
      expect(terminal.report).toMatchObject({
        outcome: "succeeded",
        source: "empty",
        summary: "",
      });
    });
  });
