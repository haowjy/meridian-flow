/**
 * Behavior coverage for the per-attempt stream driver: a slow-but-streaming
 * attempt survives the stall guard, a silent one does not, the ceiling bounds a
 * stream that never ends, and the retry gate permits reasoning-only retries
 * while refusing retries after committed output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamWithRetry } from "./attempt-stream.js";
import type { GenerateRequest, GenerateResult, ModelInfo, StreamEvent } from "./domain/index.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const MODEL: ModelInfo = {
  id: "test-model",
  provider: "test",
  tokenizer: "o200k",
  displayName: "Test Model",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  promptCache: { kind: "none", ttlMs: null },
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

describe("streamWithRetry retry gate", () => {
  it("retries when only reasoning had streamed and succeeds on the next attempt", async () => {
    const { adapter, calls } = scriptedAdapter([reasoningOnlyThenStall, textThenEnd]);

    const completion = collect(
      streamWithRetry(adapter, REQUEST, MODEL, RETRY, { stallMs: 80, ceilingMs: 0 }),
    );

    await vi.advanceTimersByTimeAsync(85);
    const events = await completion;

    expect(calls()).toBe(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(last(events)?.type).toBe("end");
  });

  it("does not retry once committed output has streamed", async () => {
    const { adapter, calls } = scriptedAdapter([textThenStall, textThenEnd]);

    const completion = collect(
      streamWithRetry(adapter, REQUEST, MODEL, RETRY, { stallMs: 80, ceilingMs: 0 }),
    );

    await vi.advanceTimersByTimeAsync(80);
    const events = await completion;

    expect(calls()).toBe(1);
    const terminal = last(events);
    expect(terminal).toMatchObject({ type: "error", retryable: true });
    expect(terminal?.type === "error" ? terminal.message : "").toContain("stalled");
  });
});

describe("streamWithRetry retry-after", () => {
  it("waits for the longer retry-after duration before retrying", async () => {
    const { adapter, calls } = scriptedAdapter([
      async function* () {
        yield {
          type: "error",
          code: "rate_limited",
          message: "retry",
          retryable: true,
          retryAfterMs: 2_500,
        };
      },
      async function* () {
        yield end;
      },
    ]);
    const completion = collect(
      streamWithRetry(
        adapter,
        REQUEST,
        MODEL,
        { maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 100 },
        {
          stallMs: 60_000,
          ceilingMs: 0,
        },
      ),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await completion;

    expect(calls()).toBe(2);
  });

  it("caps retry-after waits at 60 seconds", async () => {
    const { adapter, calls } = scriptedAdapter([
      async function* () {
        yield {
          type: "error",
          code: "rate_limited",
          message: "retry",
          retryable: true,
          retryAfterMs: 90_000,
        };
      },
      async function* () {
        yield end;
      },
    ]);
    const completion = collect(
      streamWithRetry(
        adapter,
        REQUEST,
        MODEL,
        { maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 100 },
        {
          stallMs: 60_000,
          ceilingMs: 0,
        },
      ),
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await completion;
    expect(calls()).toBe(2);
  });

  it("aborts an active retry-after wait", async () => {
    const controller = new AbortController();
    const { adapter, calls } = scriptedAdapter([
      async function* () {
        yield {
          type: "error",
          code: "rate_limited",
          message: "retry",
          retryable: true,
          retryAfterMs: 90_000,
        };
      },
      async function* () {
        yield end;
      },
    ]);
    const completion = collect(
      streamWithRetry(
        adapter,
        { ...REQUEST, signal: controller.signal },
        MODEL,
        { maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 100 },
        { stallMs: 60_000, ceilingMs: 0 },
      ),
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(completion).rejects.toBe(controller.signal.reason);
    expect(calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("per-attempt timing", () => {
  it("omits generation timing when a slow consumer backpressures the byte-bounded buffer", async () => {
    let time = 0;
    let deltaCount = 0;
    let reachByteLimit!: () => void;
    const byteLimitReached = new Promise<void>((resolve) => {
      reachByteLimit = resolve;
    });
    let releaseConsumer!: () => void;
    const consumerReleased = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const adapter: ProviderAdapter = {
      providerId: "test",
      async *stream() {
        time = 10;
        yield start;
        for (let index = 0; index < 24; index++) {
          time += 1;
          deltaCount += 1;
          if (index === 7) reachByteLimit();
          yield { type: "text.delta", text: "x".repeat(65_536) };
        }
        time += 1;
        yield end;
      },
    };

    let terminal: StreamEvent | undefined;
    const completion = (async () => {
      for await (const event of streamWithRetry(
        adapter,
        REQUEST,
        MODEL,
        RETRY,
        { stallMs: 60_000, ceilingMs: 0 },
        { now: () => time },
      )) {
        if (event.type === "start") await consumerReleased;
        if (event.type === "text.delta") {
          time += 2;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (event.type === "end") terminal = event;
      }
    })();

    await byteLimitReached;
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(deltaCount).toBe(8);
    releaseConsumer();
    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(terminal?.type === "end" ? terminal.result.timing : undefined).toEqual({
      requestStartedAt: expect.any(String),
      latencyMs: null,
      timeToFirstTokenMs: 11,
      generationMs: null,
    });
  });
});

describe("cancel drain", () => {
  it("uses one deadline even with late chunks and an iterator that ignores return", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { adapter } = scriptedAdapter([
        async function* () {
          yield { type: "text.delta", text: "first" };
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          yield { type: "text.delta", text: "late" };
          await new Promise(() => {});
        },
      ]);
      const stream = streamWithRetry(
        adapter,
        { ...REQUEST, signal: controller.signal },
        MODEL,
        { ...RETRY, maxAttempts: 1 },
        { stallMs: 60_000, ceilingMs: 60_000 },
      );
      await stream.next();
      const late = stream.next();
      controller.abort();
      await vi.advanceTimersByTimeAsync(4_000);
      expect((await late).value).toEqual({ type: "text.delta", text: "late" });
      let done = false;
      const finish = stream.next().then((result) => {
        done = result.done === true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(true);
      await finish;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
