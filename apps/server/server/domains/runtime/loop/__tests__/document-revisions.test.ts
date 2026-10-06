/** Settled tool-result metadata preserves the apply-time token, not a later writer revision. */

import { modelResult, renderAgentEditResult } from "@meridian/agent-edit";
import { describe, expect, it } from "vitest";
import { runtimeScenario } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

describe("document revision settlement", () => {
  it("records the receipt token in persisted metadata and never renders it to the model", async () => {
    const documentId = "33333333-3333-4333-8333-333333333333";
    const uri = "manuscript://chapter.md";
    const gateway = scriptedGateway({
      usage: { inputTokens: 10, outputTokens: 1 },
      results: [
        {
          content: [
            {
              type: "tool_use",
              toolCallId: "write-1",
              toolName: "write",
              input: { command: "create", path: uri, content: "New text" },
            },
          ],
          toolCalls: [],
          finishReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 1 },
          model: "gpt-4.1-mini",
          provider: "openai",
        },
      ],
    });
    const { orchestrator, repos, thread } = await runtimeScenario({
      gateway,
      toolExecutor: {
        async executeTool(call) {
          const staged = modelResult({
            command: "create",
            status: "success",
            phase: "staged",
            payload: { path: uri },
          });
          return {
            toolCallId: call.id,
            output: renderAgentEditResult(staged),
            result: JSON.parse(JSON.stringify(staged)),
            metadata: {
              stagedWrite: true,
              documentId,
              writeId: "w1",
              settlementId: "settlement-1",
              documentRevisions: [{ documentId, uri, revision: null }],
            },
          };
        },
      },
      documentRevisions: {
        async current() {
          return new Map([[documentId, "y1:later-writer-edit"]]);
        },
      },
      responseWrites: {
        async commitResponse(_responseId, _ctx, beforeCommit) {
          const result = {
            status: "committed" as const,
            receipts: [
              {
                documentId,
                receipt: {
                  writeId: "w1",
                  settlementId: "settlement-1",
                  revision: "y1:at-apply",
                  result: modelResult({ command: "create", status: "success", phase: "committed" }),
                },
              },
            ],
            concurrentEdits: [],
            refused: [],
          };
          await beforeCommit?.(result);
          return result;
        },
        async rollbackResponse() {},
      },
    });
    const run = await orchestrator.prepare({ threadId: thread.id, userText: "Write." });
    expect((await run.execute()).status).toBe("complete");
    const results = (await repos.blocks.listByThread(thread.id)).filter(
      (block) => block.blockType === "tool_result",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toMatchObject({
      output: `status: success; path: ${uri}`,
      result: { command: "create", status: "success", phase: "committed", path: uri },
      metadata: { documentRevisions: [{ documentId, uri, revision: "y1:at-apply" }] },
    });
    expect(gateway.requests).toHaveLength(2);
    expect(JSON.stringify(gateway.requests)).not.toContain("y1:");
    expect(JSON.stringify(gateway.requests)).not.toContain("documentRevisions");
  });

  it("replaces a write's result with the refusal when the save left its document out (D29)", async () => {
    const documentId = "44444444-4444-4444-8444-444444444444";
    const uri = "scratch://notes.md";
    const message = "Work @rewrite is archived and read-only. Ask the user to unarchive @rewrite.";
    const gateway = scriptedGateway({
      usage: { inputTokens: 10, outputTokens: 1 },
      results: [
        {
          content: [
            {
              type: "tool_use",
              toolCallId: "write-1",
              toolName: "write",
              input: { command: "create", path: uri, content: "Notes" },
            },
          ],
          toolCalls: [],
          finishReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 1 },
          model: "gpt-4.1-mini",
          provider: "openai",
        },
      ],
    });
    const { orchestrator, repos, thread } = await runtimeScenario({
      gateway,
      toolExecutor: {
        async executeTool(call) {
          const staged = modelResult({
            command: "create",
            status: "success",
            phase: "staged",
            payload: { path: uri },
          });
          return {
            toolCallId: call.id,
            output: renderAgentEditResult(staged),
            result: JSON.parse(JSON.stringify(staged)),
            metadata: {
              stagedWrite: true,
              documentId,
              writeId: "w1",
              settlementId: "settlement-1",
              documentRevisions: [{ documentId, uri, revision: null }],
            },
          };
        },
      },
      responseWrites: {
        async commitResponse(_responseId, _ctx, beforeCommit) {
          const result = {
            status: "committed" as const,
            receipts: [],
            concurrentEdits: [],
            refused: [{ documentId, message, reason: "work_archived" as const }],
          };
          await beforeCommit?.(result);
          return result;
        },
        async rollbackResponse() {},
      },
    });
    const run = await orchestrator.prepare({ threadId: thread.id, userText: "Write." });
    expect((await run.execute()).status).toBe("complete");
    const [block] = (await repos.blocks.listByThread(thread.id)).filter(
      (candidate) => candidate.blockType === "tool_result",
    );
    expect(block?.content).toMatchObject({
      isError: true,
      result: { status: "permission_denied", reason: "work_archived", path: uri },
    });
  });
});
