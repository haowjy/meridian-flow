/**
 * EventSink-backed lifecycle instrumentation around the provider-neutral Gateway port.
 * The decorator observes canonical events without buffering or changing gateway behavior.
 */
import type { EventCorrelation, EventLevel, EventSink } from "../../observability/index.js";
import { emitEvent } from "../../observability/index.js";
import { isPartialOutputEvent } from "./create-gateway.js";
import type { GenerateRequest, GenerateResult, StreamEvent } from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";

const VERBOSE_CHUNKS = "gateway.chunks";
const UTF8_ENCODER = new TextEncoder();

type Outcome = "ok" | "error" | "cancelled";

type TerminalEvidence = { type: "end" } | { type: "error"; cause?: unknown } | { type: "none" };

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === "AbortError";
}

function classifyTerminalOutcome(
  terminal: TerminalEvidence,
  signal: AbortSignal | undefined,
): Outcome {
  if (terminal.type === "error") {
    return "cause" in terminal && isAbortFailure(terminal.cause, signal) ? "cancelled" : "error";
  }
  if (signal?.aborted) return "cancelled";
  return terminal.type === "end" ? "ok" : "error";
}

function errorCodeFrom(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

interface CallEventMetadata {
  errorCode?: string;
  chunk?: { messageClass: StreamEvent["type"]; bytes?: number };
}

interface CallEmitter {
  emit(
    level: EventLevel,
    name: string,
    payload: Record<string, unknown>,
    route: { provider?: string; model?: string },
    metadata?: CallEventMetadata,
  ): void;
}

function createCallEmitter(
  request: GenerateRequest,
  deps: { sink: EventSink },
  gatewayCallId: string,
): CallEmitter {
  let observerSeq = 0;
  return {
    emit(level, name, payload, route, metadata) {
      try {
        const correlation: EventCorrelation = {
          ...request.correlation,
          gatewayCallId,
          ...(route.provider ? { provider: route.provider } : {}),
          ...(route.model ? { model: route.model } : {}),
          ...(metadata?.errorCode ? { errorCode: metadata.errorCode } : {}),
        };
        emitEvent(deps.sink, {
          level,
          source: "gateway",
          name,
          correlation,
          stream: {
            streamId: `gateway:${gatewayCallId}`,
            transport: "gateway",
            observedAt: "server",
            observerSeq: ++observerSeq,
            ...(metadata?.chunk
              ? {
                  messageClass: metadata.chunk.messageClass,
                  ...(metadata.chunk.bytes === undefined ? {} : { bytes: metadata.chunk.bytes }),
                }
              : {}),
          },
          payload,
        });
      } catch {
        // Observability must never change gateway control flow.
      }
    },
  };
}

function routePayload(route: { provider?: string; model?: string }): Record<string, unknown> {
  return {
    ...(route.provider ? { provider: route.provider } : {}),
    ...(route.model ? { model: route.model } : {}),
  };
}

function streamClosePayload(input: {
  durationMs: number;
  firstOutputMs?: number;
  chunkCount: number;
  chunkCounts?: ReadonlyMap<StreamEvent["type"], number>;
  result?: GenerateResult;
  outcome: Outcome;
  errorCode?: string;
}): Record<string, unknown> {
  return {
    durationMs: input.durationMs,
    ...(input.firstOutputMs === undefined ? {} : { firstOutputMs: input.firstOutputMs }),
    chunkCount: input.chunkCount,
    ...(input.chunkCounts ? { chunkCounts: Object.fromEntries(input.chunkCounts.entries()) } : {}),
    toolCallCount: input.result?.toolCalls.length ?? 0,
    ...(input.result
      ? {
          inputTokens: input.result.usage.inputTokens,
          outputTokens: input.result.usage.outputTokens,
          finishReason: input.result.finishReason,
        }
      : {}),
    outcome: input.outcome,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

type StreamTerminal =
  | { type: "end"; at: number; result: GenerateResult }
  | { type: "error"; at: number; errorCode: string };

function createStreamObservation(input: {
  request: GenerateRequest;
  emitter: CallEmitter;
  verboseChunks: boolean;
  startedAt: number;
}): {
  observe(source: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent>;
  close(): void;
} {
  let route = { provider: input.request.provider, model: input.request.model };
  let startCount = 0;
  let chunkCount = 0;
  const chunkCounts = new Map<StreamEvent["type"], number>();
  let firstOutputMs: number | undefined;
  let terminal: StreamTerminal | undefined;
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    const terminalAt = terminal?.at ?? Date.now();
    const outcome = classifyTerminalOutcome(terminal ?? { type: "none" }, input.request.signal);
    const errorCode = terminal?.type === "error" ? terminal.errorCode : undefined;
    input.emitter.emit(
      outcome === "ok" ? "info" : "warn",
      "stream.close",
      streamClosePayload({
        durationMs: terminalAt - input.startedAt,
        firstOutputMs,
        chunkCount,
        chunkCounts,
        result: terminal?.type === "end" ? terminal.result : undefined,
        outcome,
        errorCode,
      }),
      route,
      { errorCode },
    );
  }

  async function* observe(source: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
    try {
      for await (const event of source) {
        chunkCount++;
        chunkCounts.set(event.type, (chunkCounts.get(event.type) ?? 0) + 1);

        if (event.type === "start") {
          route = { provider: event.provider, model: event.model };
          startCount++;
          if (startCount === 1) {
            input.emitter.emit("debug", "stream.open", routePayload(route), route);
          } else {
            input.emitter.emit(
              "warn",
              "stream.retry",
              { attempt: startCount, ...routePayload(route) },
              route,
            );
          }
        }

        let eventAt: number | undefined;
        if (firstOutputMs === undefined && isPartialOutputEvent(event)) {
          eventAt = Date.now();
          firstOutputMs = eventAt - input.startedAt;
          input.emitter.emit("debug", "stream.first_output", { latencyMs: firstOutputMs }, route);
        }

        if (terminal === undefined && event.type === "end") {
          route = { provider: event.result.provider, model: event.result.model };
          terminal = { type: "end", result: event.result, at: eventAt ?? Date.now() };
        } else if (terminal === undefined && event.type === "error") {
          terminal = { type: "error", errorCode: event.code, at: Date.now() };
        }

        if (input.verboseChunks) {
          const bytes =
            event.type === "text.delta" || event.type === "reasoning.delta"
              ? UTF8_ENCODER.encode(event.text).byteLength
              : undefined;
          input.emitter.emit("trace", "stream.chunk", {}, route, {
            chunk:
              bytes === undefined
                ? { messageClass: event.type }
                : { messageClass: event.type, bytes },
          });
        }

        yield event;
      }
    } finally {
      close();
    }
  }

  return { observe, close };
}

/** Adds fixed-cost lifecycle events and optional metadata-only chunk events to a Gateway. */
export function createInstrumentedGateway(
  gateway: Gateway,
  deps: { sink: EventSink; verbose: ReadonlySet<string> },
): Gateway {
  const instrumented: Gateway = {
    stream(request) {
      const startedAt = Date.now();
      const gatewayCallId = crypto.randomUUID();
      const emitter = createCallEmitter(request, deps, gatewayCallId);
      const observation = createStreamObservation({
        request,
        emitter,
        verboseChunks: deps.verbose.has(VERBOSE_CHUNKS),
        startedAt,
      });
      try {
        return observation.observe(gateway.stream(request));
      } catch (error) {
        observation.close();
        throw error;
      }
    },

    async generate(request) {
      const startedAt = Date.now();
      const gatewayCallId = crypto.randomUUID();
      const emitter = createCallEmitter(request, deps, gatewayCallId);
      let route = {
        provider: request.provider,
        model: request.model,
      };
      emitter.emit("debug", "stream.open", routePayload(route), route);

      try {
        const result = await gateway.generate(request);
        const terminalAt = Date.now();
        route = { provider: result.provider, model: result.model };
        const outcome = classifyTerminalOutcome({ type: "end" }, request.signal);
        emitter.emit(
          outcome === "ok" ? "info" : "warn",
          "stream.close",
          {
            durationMs: terminalAt - startedAt,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            finishReason: result.finishReason,
            outcome,
          },
          route,
        );
        return result;
      } catch (error) {
        const terminalAt = Date.now();
        const errorCode = errorCodeFrom(error);
        const outcome = classifyTerminalOutcome({ type: "error", cause: error }, request.signal);
        emitter.emit(
          "warn",
          "stream.close",
          {
            durationMs: terminalAt - startedAt,
            outcome,
            ...(errorCode ? { errorCode } : {}),
          },
          route,
          { errorCode },
        );
        throw error;
      }
    },

    getDefaultModel() {
      return gateway.getDefaultModel();
    },
  };

  const settleCancelledResult = gateway.settleCancelledResult;
  if (settleCancelledResult) {
    instrumented.settleCancelledResult = (input) => settleCancelledResult.call(gateway, input);
  }
  const listModels = gateway.listModels;
  if (listModels) {
    instrumented.listModels = () => listModels.call(gateway);
  }

  return instrumented;
}
