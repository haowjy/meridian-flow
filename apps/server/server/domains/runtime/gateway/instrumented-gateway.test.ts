import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type { GenerateResult, StreamEvent } from "./domain/index.js";
import { createInstrumentedGateway } from "./instrumented-gateway.js";
import type { Gateway } from "./ports/gateway.js";

const TIMING = {
  requestStartedAt: "2026-09-27T12:00:00.000Z",
  latencyMs: 240,
  timeToFirstTokenMs: 80,
  generationMs: 160,
};

function result(): GenerateResult {
  return {
    content: [],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 3 },
    model: "test-model",
    provider: "test-provider",
    timing: TIMING,
  };
}

function testGateway(): Gateway {
  return {
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "start", model: "test-model", provider: "test-provider" };
      yield { type: "end", result: result() };
    },
    async generate() {
      return result();
    },
    getDefaultModel() {
      return "test-model";
    },
  };
}

describe("instrumented gateway", () => {
  it("preserves per-attempt timing and names provider versus observation durations", async () => {
    const sink = createInMemoryEventSink();
    const instrumented = createInstrumentedGateway(testGateway(), {
      sink,
      verbose: new Set(),
    });

    const events: StreamEvent[] = [];
    for await (const event of instrumented.stream({ messages: [] })) events.push(event);

    const terminal = events.at(-1);
    expect(terminal?.type === "end" ? terminal.result.timing : undefined).toEqual(TIMING);
    const close = sink.events.find((event) => event.name === "stream.close");
    expect(close?.payload).toMatchObject({
      providerLatencyMs: 240,
      providerFirstOutputMs: 80,
      providerGenerationMs: 160,
    });
    expect(close?.payload).toHaveProperty("gatewayObservationDurationMs");
    expect(close?.payload).not.toHaveProperty("durationMs");
  });

  it("keeps generate() timing from the gateway result instead of inventing a null TTFT", async () => {
    const instrumented = createInstrumentedGateway(testGateway(), {
      sink: createInMemoryEventSink(),
      verbose: new Set(),
    });

    await expect(instrumented.generate({ messages: [] })).resolves.toMatchObject({
      timing: TIMING,
    });
  });

  it("logs the provider's status on stream.close but never its response text", async () => {
    const sink = createInMemoryEventSink();
    const failing: Gateway = {
      ...testGateway(),
      async *stream(): AsyncIterable<StreamEvent> {
        yield {
          type: "error",
          code: "provider_error",
          message: "402 Insufficient Balance",
          retryable: false,
          providerResponse: {
            status: 402,
            message: "Insufficient Balance",
            body: '{"error":{"message":"Insufficient Balance"}}',
          },
        };
      },
    };
    const instrumented = createInstrumentedGateway(failing, { sink, verbose: new Set() });

    for await (const _event of instrumented.stream({ messages: [] })) {
      // drain
    }

    const close = sink.events.find((event) => event.name === "stream.close");
    expect(close?.payload).toMatchObject({ errorCode: "provider_error", providerStatus: 402 });
    expect(JSON.stringify(close)).not.toContain("Insufficient Balance");
  });
});
