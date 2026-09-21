/**
 * Behavior coverage for the per-attempt stream driver: a slow-but-streaming
 * attempt survives the stall guard, a silent one does not, the ceiling bounds a
 * stream that never ends, and the retry gate permits reasoning-only retries
 * while refusing retries after committed output.
 */
import { describe, expect, it } from "vitest";
import { streamWithRetry } from "./attempt-stream.js";
import { DEFAULT_ATTEMPT_CEILING_MS, DEFAULT_ATTEMPT_STALL_MS } from "./deadline.js";
import type { GenerateRequest, GenerateResult, ModelInfo, StreamEvent } from "./domain/index.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";

const MODEL: ModelInfo = {
  id: "test-model",
  provider: "test",
  displayName: "Test Model",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  capabilities: new Set(["streaming"]),
};

const REQUEST: GenerateRequest = { messages: [] };

const END_RESULT: GenerateResult = {
  content: [],
  toolCalls: [],
  finishReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: MODEL.id,
  provider: "test",
};

const RETRY = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 };

type Script = (signal: AbortSignal | undefined) => AsyncGenerator<StreamEvent>;

function scriptedAdapter(scripts: Script[]): {
  adapter: ProviderAdapter;
  calls: () => number;
} {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId: "test",
    stream(request) {
      const script = scripts[Math.min(calls, scripts.length - 1)];
      calls += 1;
      return script(request.signal);
    },
  };
  return { adapter, calls: () => calls };
}

/** Sleep that resolves early on abort so a scripted generator always terminates. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function last(events: StreamEvent[]): StreamEvent | undefined {
  return events[events.length - 1];
}

const start: StreamEvent = { type: "start", model: MODEL.id, provider: "test" };
const end: StreamEvent = { type: "end", result: END_RESULT };

async function* reasoningOnlyThenStall(
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamEvent> {
  yield start;
  yield { type: "reasoning.delta", text: "thinking" };
  await abortableDelay(60_000, signal);
}

async function* textThenStall(signal: AbortSignal | undefined): AsyncGenerator<StreamEvent> {
  yield start;
  yield { type: "text.delta", text: "partial answer" };
  await abortableDelay(60_000, signal);
}

async function* textThenEnd(): AsyncGenerator<StreamEvent> {
  yield start;
  yield { type: "text.delta", text: "final answer" };
  yield end;
}

async function* streamingForAWhile(signal: AbortSignal | undefined): AsyncGenerator<StreamEvent> {
  yield start;
  for (let i = 0; i < 12; i++) {
    if (signal?.aborted) return;
    yield { type: "reasoning.delta", text: `chunk-${i}` };
    await abortableDelay(15, signal);
  }
  yield end;
}

async function* streamingForever(signal: AbortSignal | undefined): AsyncGenerator<StreamEvent> {
  yield start;
  while (!signal?.aborted) {
    yield { type: "reasoning.delta", text: "tick" };
    await abortableDelay(10, signal);
  }
}

describe("streamWithRetry timeouts", () => {
  it("never aborts a slow-but-streaming attempt", async () => {
    const { adapter } = scriptedAdapter([streamingForAWhile]);

    const events = await collect(
      streamWithRetry(adapter, REQUEST, MODEL, RETRY, { stallMs: 150, ceilingMs: 0 }),
    );

    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(last(events)?.type).toBe("end");
  });

  it("bounds a stream that never ends with the ceiling backstop", async () => {
    const { adapter } = scriptedAdapter([streamingForever]);

    const events = await collect(
      streamWithRetry(
        adapter,
        REQUEST,
        MODEL,
        { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
        {
          stallMs: 60_000,
          ceilingMs: 120,
        },
      ),
    );

    const terminal = last(events);
    expect(terminal).toMatchObject({ type: "error", retryable: true });
    expect(terminal?.type === "error" ? terminal.message : "").toContain("ceiling");
  });
});

describe("streamWithRetry retry gate", () => {
  it("retries when only reasoning had streamed and succeeds on the next attempt", async () => {
    const { adapter, calls } = scriptedAdapter([reasoningOnlyThenStall, textThenEnd]);

    const events = await collect(
      streamWithRetry(adapter, REQUEST, MODEL, RETRY, { stallMs: 80, ceilingMs: 0 }),
    );

    expect(calls()).toBe(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(last(events)?.type).toBe("end");
  });

  it("does not retry once committed output has streamed", async () => {
    const { adapter, calls } = scriptedAdapter([textThenStall, textThenEnd]);

    const events = await collect(
      streamWithRetry(adapter, REQUEST, MODEL, RETRY, { stallMs: 80, ceilingMs: 0 }),
    );

    expect(calls()).toBe(1);
    const terminal = last(events);
    expect(terminal).toMatchObject({ type: "error", retryable: true });
    expect(terminal?.type === "error" ? terminal.message : "").toContain("stalled");
  });
});

describe("default timeouts", () => {
  it("exposes a 60s stall and a 15m ceiling", () => {
    expect(DEFAULT_ATTEMPT_STALL_MS).toBe(60_000);
    expect(DEFAULT_ATTEMPT_CEILING_MS).toBe(900_000);
  });
});
