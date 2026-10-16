/** Consolidated test contracts; each block retains its original fixture scope. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { describe as __mergedSuite, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { savedReportToSpawnResult } from "./saved-report-outcome.js";
import { persistReturnResult, type SpawnTranscript } from "./spawn-transcript.js";

__mergedSuite("child-run-driver.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/spawn/child-run-driver.test.ts.
  function saved(
    overrides: Partial<
      Extract<
        SavedExecutionReport,
        {
          outcome: string;
        }
      >
    > = {},
  ): SavedExecutionReport {
    return {
      childThreadId: "child-id",
      terminalTurnId: null,
      executionTurnId: "execution-id",
      admittedAt: "2026-01-01T00:00:00.000Z",
      handle: "p3",
      origin: "spawn",
      deliveryMode: "direct",
      callerThreadId: "parent-id",
      callerTurnId: "parent-turn",
      toolCallId: "spawn-call",
      cardBlockId: "card-id",
      agentSlug: "critic",
      name: null,
      capture: null,
      captureToolCallId: null,
      outcome: "succeeded",
      reason: null,
      source: "final_assistant",
      summary: "final public text",
      artifacts: null,
      costMillicredits: 42,
      terminalAt: "2026-01-01T00:00:00.000Z",
      publication: "published",
      publishedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  __mergedSuite("savedReportToSpawnResult", () => {
    it("returns exact successful execution content, never its cost", () => {
      expect(savedReportToSpawnResult(saved())).toEqual({
        status: "completed",
        execution: "execution-id",
        outcome: "succeeded",
        report: {
          handle: "p3",
          threadId: "child-id",
          source: "final_assistant",
          summary: "final public text",
        },
      });
    });
    it("keeps a failed captured candidate as partial content, not success", () => {
      const result = savedReportToSpawnResult(
        saved({
          outcome: "failed",
          reason: "max_tokens",
          source: "return_result",
          summary: "partial candidate",
          payload: { retained: true },
        }),
      );
      expect(result).toMatchObject({
        status: "error",
        execution: "execution-id",
        outcome: "failed",
        partial: true,
        reason: "max_tokens",
        report: { summary: "partial candidate", payload: { retained: true } },
      });
    });
    it("keeps cancellation distinct and refuses a nonterminal row", () => {
      const cancelled = savedReportToSpawnResult(
        saved({ outcome: "cancelled", reason: "cancelled" }),
      );
      expect(cancelled).toMatchObject({
        status: "error",
        outcome: "cancelled",
        error: { code: "spawn_cancelled" },
      });
      expect(() =>
        savedReportToSpawnResult({
          ...saved(),
          outcome: null,
          source: null,
          summary: null,
          terminalAt: null,
        }),
      ).toThrow("not terminal");
    });
  });
});

__mergedSuite("spawn-transcript.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/spawn/spawn-transcript.test.ts.
  async function setup() {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "writer", title: "Return" });
    const parent = await repos.threads.create({
      aiWriteMode: "direct",
      userId: "writer",
      projectId: project.id,
    });
    const originTurn = await repos.turns.create({
      threadId: parent.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const child = await repos.threads.createSubagent({
      aiWriteMode: "direct",
      userId: "writer",
      projectId: project.id,
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      originTurnId: originTurn.id,
      spawnDepth: 1,
    });
    const turn = await repos.turns.create({
      threadId: child.id,
      role: "assistant",
      origin: "assistant",
      status: "streaming",
      prevTurnId: null,
    });
    await repos.executionReports.admit({
      childThreadId: child.id,
      executionTurnId: turn.id,
      handle: child.ref ?? "",
      origin: "thread_run",
      deliveryMode: "none",
      callerThreadId: null,
      callerTurnId: null,
      toolCallId: null,
      cardBlockId: null,
    });
    const transcript: SpawnTranscript = {
      persistence: { repos, eventWriter: createInMemoryEventJournalWriter() },
      threadId: child.id as ThreadId,
      turnId: turn.id,
      blockSeqRef: { value: 0 },
      allBlocks: [],
    };
    return { repos, child, turn, transcript };
  }

  __mergedSuite("persistReturnResult", () => {
    it("persists a rejected competing return as a failed ordinary tool result", async () => {
      const { repos, child, turn, transcript } = await setup();
      await repos.executionReports.captureOnce(child.id, turn.id, "first", { summary: "kept" });
      const settled = await persistReturnResult(transcript, {
        toolCallId: "second",
        outcome: { ok: true },
        capture: { summary: "discarded" },
        executionReports: repos.executionReports,
      });
      expect(settled.endTurn).toBe(false);
      expect(settled.block.content).toMatchObject({
        output: "A different return_result was already accepted",
        result: { ok: false },
        isError: true,
      });
      expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
        capture: { summary: "kept" },
        captureToolCallId: "first",
      });
    });
    it("rolls the candidate back when tool-result publication fails", async () => {
      const { repos, child, turn, transcript } = await setup();
      transcript.persistence.eventWriter = {
        async appendEvent() {
          throw new Error("journal failed");
        },
      };
      await expect(
        persistReturnResult(transcript, {
          toolCallId: "return-1",
          outcome: { ok: true },
          capture: { summary: "candidate" },
          executionReports: repos.executionReports,
        }),
      ).rejects.toThrow("journal failed");
      expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
        capture: null,
        outcome: null,
      });
      expect(await repos.blocks.listByTurn(turn.id)).toEqual([]);
    });
  });

  __mergedSuite("captured candidate terminal policy", () => {
    it("does not convert captured content into success after a failed run", async () => {
      const { repos, child, turn, transcript } = await setup();
      await persistReturnResult(transcript, {
        toolCallId: "return-1",
        outcome: { ok: true },
        capture: { summary: "partial candidate", payload: { retained: true } },
        executionReports: repos.executionReports,
      });
      await finalizeExecution(
        { repos, eventWriter: transcript.persistence.eventWriter },
        {
          threadId: child.id,
          turnId: turn.id,
          cause: {
            kind: "failed",
            reason: "runtime_error",
            error: "later failure",
          },
        },
      );
      expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
        outcome: "failed",
        source: "return_result",
        summary: "partial candidate",
        payload: { retained: true },
      });
    });
  });

  async function appendPublicResponse(
    setupResult: Awaited<ReturnType<typeof setup>>,
    responseSequence: number,
    blocks: Array<{
      sequence: number;
      text: string;
    }>,
  ) {
    const response = await setupResult.repos.modelResponses.create({
      turnId: setupResult.turn.id,
      sequence: responseSequence,
      provider: "test",
      model: "test-model",
      priceSource: "unknown",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    for (const block of blocks) {
      await setupResult.repos.blocks.create({
        turnId: setupResult.turn.id,
        responseId: response.row.id,
        blockType: "text",
        sequence: block.sequence,
        content: block.text,
      });
    }
  }

  __mergedSuite("persisted execution fallback", () => {
    it("keeps a genuinely empty final response empty rather than borrowing older prose", async () => {
      const scope = await setup();
      await appendPublicResponse(scope, 0, [{ sequence: 1, text: "earlier response" }]);
      await appendPublicResponse(scope, 1, []);
      await scope.repos.blocks.create({
        turnId: scope.turn.id,
        blockType: "text",
        sequence: 2,
        content: "unattributed text",
      });
      const terminal = await finalizeExecution(
        { repos: scope.repos, eventWriter: scope.transcript.persistence.eventWriter },
        {
          threadId: scope.child.id,
          turnId: scope.turn.id,
          cause: { kind: "success", finishReason: "end_turn" },
        },
      );
      expect(terminal.report).toMatchObject({ source: "empty", summary: "" });
    });
    it("preserves same-execution durable public text when no response row committed", async () => {
      const scope = await setup();
      await scope.repos.blocks.create({
        turnId: scope.turn.id,
        blockType: "text",
        sequence: 1,
        content: "durable partial",
      });
      const terminal = await finalizeExecution(
        { repos: scope.repos, eventWriter: scope.transcript.persistence.eventWriter },
        {
          threadId: scope.child.id,
          turnId: scope.turn.id,
          cause: {
            kind: "failed",
            reason: "generator_error",
            error: "provider failed",
          },
        },
      );
      expect(terminal.report).toMatchObject({
        outcome: "failed",
        source: "final_assistant",
        summary: "durable partial",
      });
    });
  });
});
