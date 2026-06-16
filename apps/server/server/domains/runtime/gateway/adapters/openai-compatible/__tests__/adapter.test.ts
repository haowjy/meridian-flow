// biome-ignore-all lint/suspicious/noExplicitAny: Test chunks use partial provider payloads.
import { describe, expect, it } from "vitest";

import type { StreamEvent } from "../../../domain/index.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "../stream-collect.js";

function collectEvents(...chunks: any[]): {
  events: StreamEvent[];
  acc: ReturnType<typeof createStreamAccumulator>;
} {
  const acc = createStreamAccumulator("gpt-compatible", "openai-compatible");
  const events: StreamEvent[] = [];
  for (const chunk of chunks) {
    for (const event of eventsFromOpenAIChunk(chunk, acc)) {
      events.push(event);
    }
  }
  return { events, acc };
}

describe("OpenAI-compatible adapter – tool call stream", () => {
  it("keeps one stable tool-call id when arguments arrive before the provider id", () => {
    const { events, acc } = collectEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path"' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_real", function: { name: "read_file" } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"/tmp/x"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    );

    const toolDeltas = events.filter(
      (event): event is Extract<StreamEvent, { type: "tool_call.delta" }> =>
        event.type === "tool_call.delta",
    );
    expect(toolDeltas).toHaveLength(2);
    expect(new Set(toolDeltas.map((event) => event.id))).toEqual(new Set(["call_real"]));
    expect(toolDeltas.map((event) => event.argumentsDelta).join("")).toBe('{"path":"/tmp/x"}');

    const result = buildGenerateResult(acc);
    expect(result.toolCalls).toEqual([
      { id: "call_real", name: "read_file", arguments: { path: "/tmp/x" } },
    ]);
    expect(result.content).toContainEqual({
      type: "tool_use",
      toolCallId: "call_real",
      toolName: "read_file",
      input: { path: "/tmp/x" },
    });
  });

  it("uses a final synthetic id only when the provider never sends one", () => {
    const { events, acc } = collectEvents({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: "read_file", arguments: '{"path":"/tmp/x"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    expect(events.filter((event) => event.type === "tool_call.delta")).toHaveLength(0);

    const result = buildGenerateResult(acc);
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "read_file", arguments: { path: "/tmp/x" } },
    ]);
  });
});
