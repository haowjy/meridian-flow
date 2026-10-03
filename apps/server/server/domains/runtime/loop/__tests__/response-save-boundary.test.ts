/** A reply's save boundaries: where the orchestrator saves staged writes before the next call. */

import { modelResult, renderAgentEditResult } from "@meridian/agent-edit";
import { describe, expect, it } from "vitest";
import { runtimeScenario } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

const DOCUMENT_ID = "55555555-5555-4555-8555-555555555555";
const URI = "manuscript://chapter.md";

describe("reply save boundaries", () => {
  it.each([
    "undo",
    "redo",
  ] as const)("saves the reply's writes before a write %s, which then runs in a fresh reply", async (reversal) => {
    const events: string[] = [];
    const gateway = scriptedGateway({
      usage: { inputTokens: 10, outputTokens: 1 },
      results: [
        {
          content: [
            {
              type: "tool_use",
              toolCallId: "write-1",
              toolName: "write",
              input: { command: "insert", path: URI, content: "New text" },
            },
            {
              type: "tool_use",
              toolCallId: "write-2",
              toolName: "write",
              input: { command: reversal, path: URI },
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
    const { orchestrator, thread } = await runtimeScenario({
      gateway,
      toolExecutor: {
        async executeTool(call, ctx) {
          const command = (call.arguments as { command: "insert" | "undo" | "redo" }).command;
          events.push(`${command}@${ctx.responseId}`);
          if (command !== "insert") {
            const reversed = modelResult({ command, status: "success", phase: "committed" });
            return {
              toolCallId: call.id,
              output: renderAgentEditResult(reversed),
              result: JSON.parse(JSON.stringify(reversed)),
            };
          }
          const staged = modelResult({ command, status: "success", phase: "staged" });
          return {
            toolCallId: call.id,
            output: renderAgentEditResult(staged),
            result: JSON.parse(JSON.stringify(staged)),
            metadata: {
              stagedWrite: true,
              documentId: DOCUMENT_ID,
              writeId: "w1",
              settlementId: "settlement-1",
              documentRevisions: [{ documentId: DOCUMENT_ID, uri: URI, revision: null }],
            },
          };
        },
      },
      responseWrites: {
        async commitResponse(responseId, _ctx, beforeCommit) {
          events.push(`save@${responseId}`);
          const result = {
            status: "committed" as const,
            receipts: events.some((event) => event === `insert@${responseId}`)
              ? [
                  {
                    documentId: DOCUMENT_ID,
                    receipt: {
                      writeId: "w1",
                      settlementId: "settlement-1",
                      revision: "y1:saved",
                      result: modelResult({
                        command: "insert",
                        status: "success",
                        phase: "committed",
                      }),
                    },
                  },
                ]
              : [],
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

    const [insert, saveFirst, reverse, saveSecond] = events;
    const first = insert?.split("@")[1];
    const second = reverse?.split("@")[1];
    expect(events).toEqual([
      `insert@${first}`,
      `save@${first}`,
      `${reversal}@${second}`,
      `save@${second}`,
    ]);
    expect(saveFirst).toBe(`save@${first}`);
    expect(saveSecond).toBe(`save@${second}`);
    expect(second).not.toBe(first);
  });
});
