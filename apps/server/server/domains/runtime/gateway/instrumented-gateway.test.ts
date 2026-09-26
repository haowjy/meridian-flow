import { describe, expect, it } from "vitest";
import { createNoopEventSink } from "../../observability/index.js";
import type { GenerateRequest, GenerateResult, StreamEvent } from "./domain/index.js";
import { createInstrumentedGateway } from "./instrumented-gateway.js";
import type { Gateway } from "./ports/gateway.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function result(): GenerateResult {
  return {
    content: [],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "test-model",
    provider: "test-provider",
  };
}

describe("instrumented gateway timing", () => {
  it("records TTFT at the first content delta on the request-to-end clock", async () => {
    const gateway: Gateway = {
      async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
        yield { type: "start", model: "test-model", provider: "test-provider" };
        request.onProviderRequestStart?.();
        await pause(20);
        yield { type: "reasoning.delta", text: "thinking" };
        await pause(40);
        yield {
          type: "text.delta",
          text: "answer",
        };
        yield { type: "end", result: result() };
      },
      async generate() {
        return result();
      },
      getDefaultModel() {
        return "test-model";
      },
    };
    const instrumented = createInstrumentedGateway(gateway, {
      sink: createNoopEventSink(),
      verbose: new Set(),
    });

    let finalResult: GenerateResult | undefined;
    for await (const event of instrumented.stream({ messages: [] })) {
      if (event.type === "end") finalResult = event.result;
    }

    expect(finalResult?.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(finalResult?.latencyMs).toBeGreaterThanOrEqual(
      finalResult?.timeToFirstTokenMs ?? Infinity,
    );
    expect((finalResult?.latencyMs ?? 0) - (finalResult?.timeToFirstTokenMs ?? 0)).toBeGreaterThan(
      20,
    );
  });
});
