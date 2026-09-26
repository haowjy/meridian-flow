/**
 * Regression coverage for the Anthropic prompt-cache prefix guarantee
 * (`prompt-cache-marks.ts`, thread AGENTS.md / runtime CONTEXT.md): a thread's
 * whole cached request prefix must be byte-stable across requests. This test
 * drives two consecutive writer runs through the real orchestrator/delivery
 * path (in-memory ports) and asserts the second request's history reproduces
 * the first request's messages exactly, including a request-only notice
 * (`NoticePort.drainForModelContext`) delivered during the first run.
 *
 * Before the fix, `orchestrator.ts` spliced the drained notice onto the
 * request only (`attachNoticesToLatestUserMessage`) and never persisted it, so
 * the second request lost the notice text entirely: the previously-final
 * message's bytes changed, which falls back the Anthropic cache breakpoint to
 * the system prompt and drops the notice from the model's history.
 */
import { describe, expect, it } from "vitest";
import type { GenerateResult, Message } from "../../gateway/index.js";
import { createTestAgentBinding, createTestNoticePort } from "./runtime-fixtures.js";
import { runtimeScenario } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

function textResult(text: string): GenerateResult {
  return {
    content: [{ type: "text", text }],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 100 },
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

/** Strips the ephemeral prompt-cache marks so marks-only diffs don't fail the comparison. */
function stripCacheMarks(messages: readonly Message[]): unknown {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((part) => {
      const { providerOptions, cacheBreakpoint, ...rest } = part as {
        providerOptions?: unknown;
        cacheBreakpoint?: unknown;
      } & typeof part;
      return rest;
    }),
  }));
}

async function setup() {
  const gateway = scriptedGateway({ results: [textResult("first"), textResult("second")] });
  const notices = createTestNoticePort();
  // `agentRevisions` closes over `threadId`, resolved lazily once the thread
  // exists: `runtimeScenario` creates it before any run reads the binding.
  let threadId = "";
  const rig = await runtimeScenario({
    gateway: {
      ...gateway,
      listModels: () => [
        {
          id: "gpt-4.1-mini",
          provider: "openai",
          displayName: "Test model",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          capabilities: new Set(["caching"]),
        },
      ],
    },
    notices,
    agentRevisions: createTestAgentBinding("gpt-4.1-mini", "", () => [threadId]),
  });
  threadId = rig.thread.id;
  return { ...rig, notices, requests: gateway.requests };
}

describe("request-only notice byte-stability across requests", () => {
  it("reproduces a drained undo notice identically on the next run's request", async () => {
    const { thread, notices, orchestrator, requests } = await setup();

    await notices.record({
      kind: "awareness_degraded",
      scope: { kind: "thread", threadId: thread.id },
      message: "Awareness degraded for chapter-3.md.",
      data: { documentIds: ["chapter-3"], documentNames: ["chapter-3.md"] },
    });

    const first = await orchestrator.prepare({ threadId: thread.id, userText: "hello" });
    await first.execute();
    expect(requests).toHaveLength(1);

    const second = await orchestrator.prepare({ threadId: thread.id, userText: "world" });
    await second.execute();
    expect(requests).toHaveLength(2);

    const firstMessages = requests[0]?.messages ?? [];
    const secondMessages = requests[1]?.messages ?? [];

    // The undo notice must actually have reached the first request; otherwise
    // this test would pass for the wrong reason.
    const firstHasNotice = firstMessages.some((message) =>
      message.content.some((part) => part.type === "text" && part.text.includes("chapter-3.md")),
    );
    expect(firstHasNotice).toBe(true);

    // Every message before the new run's own trailing message must be a
    // byte-identical (modulo cache marks) prefix of the previous request.
    expect(secondMessages.length).toBeGreaterThan(firstMessages.length);
    const strippedFirst = stripCacheMarks(firstMessages);
    const strippedSecond = stripCacheMarks(secondMessages.slice(0, firstMessages.length));
    expect(strippedSecond).toEqual(strippedFirst);
  });
});
