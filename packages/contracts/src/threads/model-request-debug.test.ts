import { describe, expect, it } from "vitest";
import type { ModelRequestDebugRecord } from "./model-request-debug.js";

describe("ModelRequestDebugRecord JSON-natural", () => {
  it("round-trips through JSON serialization", () => {
    const record: ModelRequestDebugRecord = {
      threadId: "thread-1",
      turnId: "turn-1",
      iteration: 0,
      requestedAt: "2026-06-10T12:00:00.000Z",
      agentSlug: "agent-one",
      model: "mock-llm-v1",
      provider: null,
      reasoning: { effort: "medium" },
      systemMessages: ["Agent body\n\nRuntime URI rules: …"],
      skills: [{ slug: "skill-one", layer: "workbench" }],
      tools: [{ name: "read", source: "core", capability: null }],
      messageCount: 3,
    };

    const roundTripped = JSON.parse(JSON.stringify(record)) as ModelRequestDebugRecord;
    expect(roundTripped).toEqual(record);
  });
});
