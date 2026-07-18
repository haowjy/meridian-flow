/** Behavioral tests for Gateway lifecycle instrumentation and its fixed default event budget. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryEventSink,
  type EventRecord,
  type EventSink,
} from "../../observability/index.js";
import type { GenerateRequest, GenerateResult, StreamEvent } from "./domain/index.js";
import { createInstrumentedGateway } from "./instrumented-gateway.js";
import type { Gateway } from "./ports/gateway.js";

const request: GenerateRequest = {
  provider: "test-provider",
  model: "test-model",
  messages: [],
  correlation: {
    threadId: "thread-1",
    turnId: "turn-1",
    iteration: 3,
    agentSlug: "writer",
  },
};

const result: GenerateResult = {
  content: [{ type: "text", text: "hello" }],
  toolCalls: [{ id: "call-1", name: "search", arguments: { query: "x" } }],
  finishReason: "tool_use",
  usage: { inputTokens: 11, outputTokens: 7 },
  model: "test-model",
  provider: "test-provider",
};

function scriptedGateway(events: StreamEvent[], generated = result): Gateway {
  return {
    stream() {
      return (async function* () {
        yield* events;
      })();
    },
    async generate() {
      return generated;
    },
    getDefaultModel() {
      return "default-model";
    },
  };
}

type TrackedStep = StreamEvent | { throws: Error } | { before: () => void; event?: StreamEvent };

class TrackedStream implements AsyncIterableIterator<StreamEvent> {
  private index = 0;

  constructor(private readonly steps: TrackedStep[]) {}

  readonly next = vi.fn(async (): Promise<IteratorResult<StreamEvent>> => {
    const step = this.steps[this.index++];
    if (step === undefined) return { done: true, value: undefined };
    if ("throws" in step) throw step.throws;
    if ("before" in step) {
      step.before();
      return step.event === undefined
        ? { done: true, value: undefined }
        : { done: false, value: step.event };
    }
    return { done: false, value: step };
  });

  readonly return = vi.fn(
    async (): Promise<IteratorResult<StreamEvent>> => ({
      done: true,
      value: undefined,
    }),
  );

  readonly throw = vi.fn(async (error?: unknown): Promise<IteratorResult<StreamEvent>> => {
    throw error;
  });

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> {
    return this;
  }
}

function trackedGateway(stream: TrackedStream): Gateway {
  return {
    ...scriptedGateway([]),
    stream: () => stream,
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function eventNames(events: EventRecord[]): string[] {
  return events.map((event) => event.name);
}

afterEach(() => vi.restoreAllMocks());

describe("createInstrumentedGateway stream", () => {
  it("emits one correlated happy-path lifecycle with counts and latencies", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValueOnce(175);
    const sink = createInMemoryEventSink();
    const scripted: StreamEvent[] = [
      { type: "start", provider: "test-provider", model: "test-model" },
      { type: "text.delta", text: "hello" },
      { type: "end", result },
    ];
    const gateway = createInstrumentedGateway(scriptedGateway(scripted), {
      sink,
      verbose: new Set(),
    });

    expect(await collect(gateway.stream(request))).toEqual(scripted);
    expect(eventNames(sink.events)).toEqual(["stream.open", "stream.first_output", "stream.close"]);
    expect(sink.events[0]?.payload).toEqual({
      provider: "test-provider",
      model: "test-model",
    });
    expect(sink.events[1]?.payload).toEqual({ latencyMs: 25 });
    expect(sink.events[2]).toMatchObject({
      level: "info",
      payload: {
        durationMs: 75,
        firstOutputMs: 25,
        chunkCount: 3,
        toolCallCount: 1,
        inputTokens: 11,
        outputTokens: 7,
        finishReason: "tool_use",
        outcome: "ok",
      },
    });

    const gatewayCallId = sink.events[0]?.correlation?.gatewayCallId;
    expect(gatewayCallId).toEqual(expect.any(String));
    for (const event of sink.events) {
      expect(event.source).toBe("gateway");
      expect(event.correlation).toEqual({
        ...request.correlation,
        gatewayCallId,
        provider: "test-provider",
        model: "test-model",
      });
      expect(event.stream).toMatchObject({
        streamId: `gateway:${gatewayCallId}`,
        transport: "gateway",
        observedAt: "server",
      });
    }
    expect(sink.events.map((event) => event.stream?.observerSeq)).toEqual([1, 2, 3]);
  });

  it("emits a retry for the second start event", async () => {
    const sink = createInMemoryEventSink();
    const gateway = createInstrumentedGateway(
      scriptedGateway([
        { type: "start", provider: "test-provider", model: "test-model" },
        { type: "start", provider: "fallback", model: "fallback-model" },
        { type: "end", result: { ...result, provider: "fallback", model: "fallback-model" } },
      ]),
      { sink, verbose: new Set() },
    );

    await collect(gateway.stream(request));

    const retry = sink.events.filter((event) => event.name === "stream.retry");
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      level: "warn",
      correlation: { provider: "fallback", model: "fallback-model" },
      payload: { attempt: 2, provider: "fallback", model: "fallback-model" },
    });
  });

  it("prefers cancelled when the request signal is aborted at terminal", async () => {
    const controller = new AbortController();
    controller.abort();
    const sink = createInMemoryEventSink();
    const gateway = createInstrumentedGateway(
      scriptedGateway([
        { type: "start", provider: "test-provider", model: "test-model" },
        { type: "end", result },
      ]),
      { sink, verbose: new Set() },
    );

    await collect(gateway.stream({ ...request, signal: controller.signal }));

    expect(sink.events.at(-1)).toMatchObject({
      name: "stream.close",
      level: "warn",
      payload: { outcome: "cancelled" },
    });
  });

  it("emits no chunks by default and metadata-only chunks when enabled", async () => {
    const scripted: StreamEvent[] = [
      { type: "start", provider: "test-provider", model: "test-model" },
      { type: "text.delta", text: "secret delta" },
      { type: "end", result },
    ];
    const quietSink = createInMemoryEventSink();
    const verboseSink = createInMemoryEventSink();

    await collect(
      createInstrumentedGateway(scriptedGateway(scripted), {
        sink: quietSink,
        verbose: new Set(),
      }).stream(request),
    );
    await collect(
      createInstrumentedGateway(scriptedGateway(scripted), {
        sink: verboseSink,
        verbose: new Set(["gateway.chunks"]),
      }).stream(request),
    );

    expect(quietSink.events.some((event) => event.name === "stream.chunk")).toBe(false);
    const chunks = verboseSink.events.filter((event) => event.name === "stream.chunk");
    expect(chunks.map((event) => event.stream?.messageClass)).toEqual([
      "start",
      "text.delta",
      "end",
    ]);
    expect(chunks.map((event) => event.stream?.bytes)).toEqual([undefined, 12, undefined]);
    expect(JSON.stringify(chunks)).not.toContain("secret delta");
    expect(verboseSink.events.map((event) => event.stream?.observerSeq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("stays within the default lifecycle budget for a 100-chunk stream", async () => {
    const sink = createInMemoryEventSink();
    const chunks: StreamEvent[] = Array.from({ length: 100 }, () => ({
      type: "text.delta",
      text: "x",
    }));
    const gateway = createInstrumentedGateway(
      scriptedGateway([
        { type: "start", provider: "test-provider", model: "test-model" },
        ...chunks,
        { type: "end", result },
      ]),
      { sink, verbose: new Set() },
    );

    await collect(gateway.stream(request));

    expect(sink.events).toHaveLength(3);
    expect(sink.events.length).toBeLessThanOrEqual(5);
    expect(sink.events.at(-1)?.payload.chunkCount).toBe(102);
  });

  it("does not let sink failures alter yielded events", async () => {
    const scripted: StreamEvent[] = [
      { type: "start", provider: "test-provider", model: "test-model" },
      { type: "end", result },
    ];
    const throwingSink: EventSink = {
      emit() {
        throw new Error("sink failed");
      },
      emitBatch() {
        throw new Error("sink failed");
      },
      async flush() {},
    };
    const gateway = createInstrumentedGateway(scriptedGateway(scripted), {
      sink: throwingSink,
      verbose: new Set(),
    });

    expect(await collect(gateway.stream(request))).toEqual(scripted);
  });

  describe("terminal shapes", () => {
    const start: StreamEvent = {
      type: "start",
      provider: "test-provider",
      model: "test-model",
    };
    const delta: StreamEvent = { type: "text.delta", text: "hello" };
    const yieldedError: StreamEvent = {
      type: "error",
      code: "provider_error",
      message: "failed",
      retryable: false,
    };

    interface TerminalShape {
      request: GenerateRequest;
      steps: TrackedStep[];
      yielded: StreamEvent[];
      outcome: "ok" | "error" | "cancelled";
      errorCode?: string;
      thrown?: unknown;
      nextCalls: number;
    }

    const terminalShapes: Array<{ name: string; arrange: () => TerminalShape }> = [
      {
        name: "gives an aborted yielded error precedence",
        arrange() {
          const controller = new AbortController();
          controller.abort();
          return {
            request: { ...request, signal: controller.signal },
            steps: [start, yieldedError] satisfies TrackedStep[],
            yielded: [start, yieldedError],
            outcome: "error",
            errorCode: "provider_error",
            nextCalls: 3,
          };
        },
      },
      {
        name: "rethrows a mid-stream source failure",
        arrange() {
          const error = new Error("stream failed");
          return {
            request,
            steps: [start, delta, { throws: error }] satisfies TrackedStep[],
            yielded: [start, delta],
            outcome: "error",
            thrown: error,
            nextCalls: 3,
          };
        },
      },
      {
        name: "classifies an abort during iteration as cancelled",
        arrange() {
          const controller = new AbortController();
          return {
            request: { ...request, signal: controller.signal },
            steps: [
              start,
              { before: () => controller.abort(), event: delta },
            ] satisfies TrackedStep[],
            yielded: [start, delta],
            outcome: "cancelled",
            nextCalls: 3,
          };
        },
      },
      {
        name: "forwards every event after the first terminal",
        arrange() {
          return {
            request,
            steps: [start, { type: "end", result }, yieldedError] satisfies TrackedStep[],
            yielded: [start, { type: "end", result }, yieldedError],
            outcome: "ok",
            nextCalls: 4,
          };
        },
      },
    ];

    it.each(terminalShapes)("$name", async ({ arrange }) => {
      const shape = arrange();
      const source = new TrackedStream(shape.steps);
      const sink = createInMemoryEventSink();
      const gateway = createInstrumentedGateway(trackedGateway(source), {
        sink,
        verbose: new Set(),
      });
      const yielded: StreamEvent[] = [];
      let thrown: unknown;

      try {
        for await (const event of gateway.stream(shape.request)) yielded.push(event);
      } catch (error) {
        thrown = error;
      }

      expect(yielded).toEqual(shape.yielded);
      expect(thrown).toBe(shape.thrown);
      expect(source.next).toHaveBeenCalledTimes(shape.nextCalls);
      expect(source.return).not.toHaveBeenCalled();
      expect(source.throw).not.toHaveBeenCalled();
      const closes = sink.events.filter((event) => event.name === "stream.close");
      expect(closes).toHaveLength(1);
      expect(closes[0]?.payload).toMatchObject({
        outcome: shape.outcome,
        ...(shape.errorCode ? { errorCode: shape.errorCode } : {}),
      });
    });

    it("closes and rethrows when stream construction fails synchronously", () => {
      const error = new Error("stream construction failed");
      const sink = createInMemoryEventSink();
      const gateway = createInstrumentedGateway(
        {
          ...scriptedGateway([]),
          stream() {
            throw error;
          },
        },
        { sink, verbose: new Set() },
      );

      expect(() => gateway.stream(request)).toThrow(error);
      expect(sink.events.filter((event) => event.name === "stream.close")).toHaveLength(1);
      expect(sink.events.at(-1)?.payload.outcome).toBe("error");
    });

    it("delegates consumer cleanup to the source iterator", async () => {
      const source = new TrackedStream([start, delta]);
      const sink = createInMemoryEventSink();
      const gateway = createInstrumentedGateway(trackedGateway(source), {
        sink,
        verbose: new Set(),
      });
      const yielded: StreamEvent[] = [];

      for await (const event of gateway.stream(request)) {
        yielded.push(event);
        break;
      }

      expect(yielded).toEqual([start]);
      expect(source.next).toHaveBeenCalledOnce();
      expect(source.return).toHaveBeenCalledOnce();
      expect(source.throw).not.toHaveBeenCalled();
      expect(sink.events.filter((event) => event.name === "stream.close")).toHaveLength(1);
      expect(sink.events.at(-1)?.payload.outcome).toBe("error");
    });
  });
});

describe("createInstrumentedGateway generate", () => {
  it("emits only open and close with result usage", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(260);
    const sink = createInMemoryEventSink();
    const gateway = createInstrumentedGateway(scriptedGateway([]), {
      sink,
      verbose: new Set(["gateway.chunks"]),
    });

    expect(await gateway.generate(request)).toEqual(result);

    expect(eventNames(sink.events)).toEqual(["stream.open", "stream.close"]);
    expect(sink.events[1]).toMatchObject({
      level: "info",
      payload: {
        durationMs: 60,
        inputTokens: 11,
        outputTokens: 7,
        finishReason: "tool_use",
        outcome: "ok",
      },
    });
    expect(sink.events[0]?.correlation?.gatewayCallId).toBe(
      sink.events[1]?.correlation?.gatewayCallId,
    );
    for (const event of sink.events) {
      expect(event.correlation).toMatchObject({
        ...request.correlation,
        provider: "test-provider",
        model: "test-model",
      });
    }
    expect(sink.events.map((event) => event.stream?.observerSeq)).toEqual([1, 2]);
  });
});
