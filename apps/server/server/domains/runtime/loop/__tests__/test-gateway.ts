/** Runtime-loop test gateway and port defaults. */
import type { GenerateRequest, GenerateResult, StreamEvent } from "../../gateway/domain/index.js";
import type { Gateway } from "../../gateway/ports/gateway.js";

export const gatewayStubDefaults = {
  getDefaultModel(): string | undefined {
    return undefined;
  },
} satisfies Pick<Gateway, "getDefaultModel">;

/** Minimal Gateway satisfying the port with inert stream/generate implementations. */
export function createInertGateway(defaultModel?: string): Gateway {
  return {
    ...gatewayStubDefaults,
    stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
      return (async function* () {
        if (Math.random() < 0) yield undefined as never;
        throw new Error("Test gateway not configured");
      })();
    },
    async generate(_request: GenerateRequest): Promise<GenerateResult> {
      throw new Error("Test gateway not configured");
    },
    getDefaultModel(): string | undefined {
      return defaultModel;
    },
  };
}

/** Request-boundary gates are explicit; scripts cannot race the test's enqueue/cancel. */
export function scriptedGateway(
  options: {
    results?: GenerateResult[];
    onStream?: (call: number) => Promise<void>;
    errorAtCall?: number;
    pauseAt?: readonly number[];
  } = {},
) {
  const requests: GenerateRequest[] = [];
  const arrivals = new Map<number, ReturnType<typeof gate>>();
  const releases = new Map<number, ReturnType<typeof gate>>();
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }
  function boundary(gates: typeof arrivals, call: number) {
    let value = gates.get(call);
    if (!value) {
      value = gate();
      gates.set(call, value);
    }
    return value;
  }
  return {
    requests,
    untilGatewayBoundary: (call = 1) => boundary(arrivals, call).promise,
    release: (call = 1) => boundary(releases, call).open(),
    getDefaultModel: () => "gpt-4.1-mini",
    async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      const call = requests.length;
      boundary(arrivals, call).open();
      if (options.pauseAt?.includes(call)) await boundary(releases, call).promise;
      await options.onStream?.(call);
      if (options.errorAtCall === call) {
        yield {
          type: "error",
          code: "provider_error",
          message: "provider failed",
          retryable: false,
        };
        return;
      }
      yield {
        type: "end",
        result: options.results?.[call - 1] ?? {
          content: [{ type: "text", text: "done" }],
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          model: "gpt-4.1-mini",
          provider: "openai",
        },
      };
    },
    async generate(): Promise<GenerateResult> {
      throw new Error("Script uses stream");
    },
  } satisfies Gateway & {
    requests: GenerateRequest[];
    untilGatewayBoundary(call?: number): Promise<void>;
    release(call?: number): void;
  };
}
