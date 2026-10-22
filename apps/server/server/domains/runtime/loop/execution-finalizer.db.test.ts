/** PostgreSQL terminal A: turn, report, journal, and publication share one commit. */

import type { FailureRecord } from "@meridian/contracts/failures";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { recordFailureAfterCommit } from "../../../shared/failure-records.js";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import { createQuietDrizzleJournalWriter } from "../../../test-support/journal-writer.js";
import { noFailureRecorder } from "../../threads/ports/event-journal.js";
import { processDetachedWork } from "../detached-work.js";
import { createTestDrizzleDelivery } from "./__tests__/test-drizzle-delivery.js";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-000000000ad1",
  project: "00000000-0000-4000-8000-000000000ad2",
  caller: "00000000-0000-4000-8000-000000000ad3" as ThreadId,
  child: "00000000-0000-4000-8000-000000000ad4" as ThreadId,
  callerTurn: "00000000-0000-4000-8000-000000000ad5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-000000000ad6" as TurnId,
  execution: "00000000-0000-4000-8000-000000000ad7" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("execution terminal A (postgres)", () => {});
else
  describe("execution terminal A (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
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
    const eventWriter = createQuietDrizzleJournalWriter(db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      const scenario = await executionScenario(db, ids);
      await scenario.admit();
    });

    afterAll(async () => {
      await db.close();
    });

    it("cancels only the adopted inbox batch atomically, leaving later messages for a new turn", async () => {
      const { createLockedDrizzleInbox } = await import("../../../test-support/locked-inbox.js");
      const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
      const { createRuntimeHarness } = await import("./__tests__/runtime-harness.js");
      const inbox = createLockedDrizzleInbox(db);
      const authority = createDrizzleRunClaim(db);
      const enqueue = (text: string) =>
        inbox.enqueue({
          threadId: ids.caller,
          intent: "message",
          provenance: { kind: "writer", actorId: ids.user },
          body: { kind: "text", text },
          idempotencyKey: text,
        });
      const stopped = await enqueue("stopped request");
      {
        const controller = new AbortController();
        const orchestrator = createRuntimeHarness({
          backgroundTasks: processDetachedWork,
          repos,
          eventWriter,
          delivery: createTestDrizzleDelivery(db, { repos, eventWriter, runClaim: authority }),
          runClaim: authority,
          boundThreads: () => [ids.caller],
        }).orchestrator;
        const handle = await orchestrator.prepare({
          threadId: ids.caller,
          drain: true,
          signal: controller.signal,
        });
        const later = await enqueue("later request");
        controller.abort();
        expect((await inbox.selectPending(ids.caller)).map((row) => row.id)).toEqual([
          stopped.id,
          later.id,
        ]);
        expect((await handle.execute()).status).toBe("cancelled");
        expect((await repos.turns.findById(handle.executionTurnId))?.status).toBe("cancelled");
        expect((await inbox.selectPending(ids.caller)).map((row) => row.id)).toEqual([later.id]);
        expect(await authority.holder(ids.caller)).toBeNull();
        // The release's wake starts the later request in a new turn.
        await processDetachedWork.drain();
        expect(await inbox.selectPending(ids.caller)).toEqual([]);
        const tail = (await repos.turns.listByThread(ids.caller)).at(-1);
        expect(tail?.id).not.toBe(handle.executionTurnId);
        expect(tail?.role).toBe("assistant");
      }
    });

    it.each([
      "tool",
      "rollback",
    ] as const)("splits an ordered mixed batch at %s with one lease and report", async (boundary) => {
      const { createLockedDrizzleInbox } = await import("../../../test-support/locked-inbox.js");
      const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
      const { persistWriterEnqueue } = await import("./writer-enqueue.js");
      const { createRuntimeHarness } = await import("./__tests__/runtime-harness.js");
      const { readThreadReport } = await import("../spawn/read-thread-report.js");
      const { readRunStateAtHead } = await import("../adapters/drizzle-run-state.js");
      const { createInertGateway } = await import("./__tests__/test-gateway.js");
      const inbox = createLockedDrizzleInbox(db);
      const authority = createDrizzleRunClaim(db);
      const producer = createTestDrizzleDelivery(db, { repos, eventWriter, runClaim: authority });
      const controller = new AbortController();
      const requests: import("../gateway/index.js").GenerateRequest[] = [];
      const messageIds: string[] = [];
      let selector: TurnId;
      let terminal: TurnId | null = null;
      let splitState: unknown;
      const cleanupWakes: ThreadId[] = [];
      let failSplit = boundary === "rollback";
      const splitWriter: typeof eventWriter = {
        ...noFailureRecorder,
        async appendEvent(threadId, event) {
          if (
            failSplit &&
            selector &&
            event.type === "turn.created" &&
            event.turn.role === "assistant" &&
            event.turn.id !== selector
          ) {
            failSplit = false;
            throw new Error("split journal failed");
          }
          return eventWriter.appendEvent(threadId, event);
        },
      };
      const harness = createRuntimeHarness({
        backgroundTasks: processDetachedWork,
        repos,
        eventWriter: splitWriter,
        ...(boundary === "rollback"
          ? {
              wakeIfRunnable: async (threadId: ThreadId) => {
                cleanupWakes.push(threadId);
              },
            }
          : {}),
        delivery: createTestDrizzleDelivery(db, {
          repos,
          eventWriter: splitWriter,
          runClaim: authority,
        }),
        runClaim: authority,
        boundThreads: () => [ids.caller, ids.child],
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
                  threadId: ids.caller,
                  reportId: ids.callerTurn,
                  handle: "p1",
                  outcome: "succeeded",
                  agentName: "Subagent",
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
                delivery: producer,
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
                report: await repos.executionReports.findByExecution(ids.child, selector),
                lookup: await readThreadReport({
                  callerThreadId: ids.caller,
                  ref: "p1",

                  repos,
                }),
                pending: (await readRunStateAtHead(db, ids.child)).items,
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
      await harness.creditLedger.grant({
        userId: ids.user,
        source: "manual",
        amountMillicredits: "1000000",
        reason: "split",
      });
      {
        const run = await harness.orchestrator.prepare({
          threadId: ids.child,
          userText: "start",
          signal: controller.signal,
          onCurrentTurnChanged: ({ id }) => {
            terminal = id;
          },
        });
        selector = run.executionTurnId;
        const outcome = await run.execute();
        const events = (await createDrizzleEventJournalReader(db).listByThread(ids.child)).map(
          (entry) => entry.payload,
        );
        expect(outcome.status).toBe(boundary === "rollback" ? "error" : "complete");
        const turns = await repos.turns.listByThread(ids.child);
        if (boundary === "rollback") {
          // The fixture gates the cleanup wake: assert the released lease and pending
          // messages at that barrier, then drive the successor separately.
          await processDetachedWork.drain();
          expect(cleanupWakes).toEqual([ids.child]);
          expect(terminal).toBeNull();
          expect((await repos.turns.findById(selector))?.status).toBe("error");
          expect(await repos.executionReports.findByExecution(ids.child, selector)).toMatchObject({
            terminalTurnId: selector,
            outcome: "failed",
            summary: "before steer",
          });
          expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
          expect((await inbox.selectPending(ids.child)).map((message) => message.id)).toEqual(
            messageIds,
          );
          expect(await authority.holder(ids.child)).toBeNull();
          const { createWakeIfRunnable } = await import("./wake-if-runnable.js");
          const wake = createWakeIfRunnable({
            delivery: harness.deps.delivery,
            runStarter: {
              async start(threadId) {
                const successor = await harness.orchestrator.prepare({ threadId, drain: true });
                expect(successor.executionId).not.toBe(run.executionId);
                expect(await authority.holder(threadId)).toBe(successor.executionId);
                expect((await successor.execute()).status).toBe("complete");
              },
            },
          });
          while (cleanupWakes.length) {
            const threadId = cleanupWakes.shift();
            if (threadId) await wake(threadId);
            await processDetachedWork.drain();
          }
          expect(await inbox.selectPending(ids.child)).toEqual([]);
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
          executionTurnId: selector,
          terminalTurnId: terminal,
          outcome: "succeeded",
          summary: "after steer",
        });
        expect(await repos.executionReports.findByExecution(ids.child, terminal)).toBeNull();
        const costs = await Promise.all(
          [selector, terminal].map((id) => repos.modelResponses.listByTurn(id)),
        );
        expect(report?.costMillicredits).toBe(
          costs.flat().reduce((sum, response) => sum + Number(response.millicredits), 0),
        );
        expect(await inbox.selectPending(ids.child)).toEqual([]);
        expect(await authority.holder(ids.child)).toBeNull();
        expect(events.filter((event) => event.type === "turn.completed").length).toBe(2);
        {
          expect(splitState).toMatchObject({
            run: run.executionId,
            report: { outcome: null, terminalTurnId: null },
            lookup: { status: "unavailable" },
            pending: [{ deliveryState: "awaiting_run" }, { deliveryState: "awaiting_run" }],
          });
          const text = JSON.stringify(requests[1]?.messages);
          expect(text.indexOf("before steer")).toBeLessThan(text.indexOf("child notification"));
          expect(text.indexOf("child notification")).toBeLessThan(text.indexOf("writer steer"));
        }
      }
    });

    it("rolls terminal turn and report obligation back together, then retries idempotently", async () => {
      // Risk: a failure logged for a settlement that never committed, or logged twice for one that retried.
      const emitted: FailureRecord[] = [];
      const logged = {
        appendEvent: (...args: Parameters<typeof eventWriter.appendEvent>) =>
          eventWriter.appendEvent(...args),
        recordFailure: (record: FailureRecord) =>
          recordFailureAfterCommit(record, (out) => emitted.push(out)),
      };
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
        summary: "candidate",
      });
      await expect(
        repos.transaction(async () => {
          await finalizeExecution(
            { repos, eventWriter: logged },
            {
              threadId: ids.child,
              turnId: ids.execution,
              cause: {
                kind: "failed",
                reason: "budget",
                error: "budget exhausted",
              },
            },
          );
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");
      expect((await repos.turns.findById(ids.execution))?.status).toBe("streaming");
      expect(emitted).toEqual([]);
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toMatchObject({
        capture: { summary: "candidate" },
        outcome: null,
        publication: "none",
      });

      const first = await finalizeExecution(
        { repos, eventWriter: logged },
        {
          threadId: ids.child,
          turnId: ids.execution,
          cause: {
            kind: "failed",
            reason: "budget",
            error: "budget exhausted",
          },
        },
      );
      expect(first.events.map((event) => event.type)).toEqual(["turn.error"]);
      expect(first.events[0]).toMatchObject({
        type: "turn.error",
        error: { details: { reason: "budget" } },
      });
      expect(first.report).toMatchObject({
        outcome: "failed",
        source: "return_result",
        summary: "candidate",
        publication: "pending",
      });
      const replay = await finalizeExecution(
        { repos, eventWriter: logged },
        {
          threadId: ids.child,
          turnId: ids.execution,
          cause: {
            kind: "failed",
            reason: "budget",
            error: "budget exhausted",
          },
        },
      );
      expect(replay.events).toEqual([]);
      expect(emitted).toEqual([
        expect.objectContaining({
          occurrenceId: ids.execution,
          phase: "recorded",
          failure: expect.objectContaining({ category: "reply", source: "bug" }),
        }),
      ]);
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
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      const final = await repos.modelResponses.create({
        turnId: ids.execution,
        sequence: 1,
        provider: "test",
        model: "test-model",
        priceSource: "unknown",
        millicredits: "4",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
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
          turnId: ids.execution,
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
  });
