/**
 * Gateway factory: assembles the provider registry from config, wires the
 * anthropic/openai/openai-compatible adapters, and returns a Gateway that routes
 * each request to its provider and applies per-attempt timeouts. The gateway's
 * composition root; depends on the adapters, routing, and deadline helpers.
 *
 * ── how it works ──
 * 1. createAdapter() maps each ProviderConfig.adapter string to its factory.
 * 2. buildProviderRegistry() indexes models by ID so resolveRoute() can look up
 *    adapter + model in O(1).
 * 3. gateway.stream() is the main entry point:
 *    a. Without fallback: resolve the primary route, stream with retry.
 *    b. With fallback: iterate fallback provider list; for each, streamForProvider()
 *       runs streamWithRetry(). On retryable error before output, move to next
 *       fallback. On error after output, propagate immediately.
 * 4. streamWithRetry() runs one provider with up to `retry.maxAttempts` attempts.
 *    Each attempt has a wall-clock deadline via createModelAttemptSignal.
 *    Retry only happens after a retryable error, before any output has been
 *    emitted to the caller. After output is emitted, errors propagate instantly.
 * 5. gateway.generate() is the convenience wrapper: consumeStream(gateway.stream()).
 *
 * ── abort/cleanup contract ──
 * - Every attempt creates a derived AbortSignal from createModelAttemptSignal
 *   (deadline.ts) that combines the parent signal with a per-attempt timeout.
 * - nextStreamEvent() races the iterator against the abort signal so an
 *   in-flight provider stream is interrupted on timeout or cancellation.
 * - The finally block calls iterator.return() to release provider stream
 *   resources, then cleanup() to clear the timeout timer.
 */
import { createAnthropicAdapter } from "./adapters/anthropic/adapter.js";
import { createOpenAIResponsesAdapter } from "./adapters/openai/adapter.js";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible/adapter.js";
import { consumeStream } from "./consume-stream.js";
import { createModelAttemptSignal, modelAttemptTimeoutEvent } from "./deadline.js";
import type {
  GatewayConfig,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  StreamEvent,
} from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import {
  buildProviderRegistry,
  fallbackProviderIds,
  type ProviderRegistry,
  resolveRoute,
} from "./routing.js";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;

/** Abort-aware sleep used for exponential backoff between retry attempts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Maps a ProviderConfig.adapter string to its concrete ProviderAdapter factory.
 * `openrouter` is reserved in BuiltinAdapter but throws — no implementation exists yet.
 */
function createAdapter(config: GatewayConfig["providers"][number]): ProviderAdapter {
  switch (config.adapter) {
    case "openai-compatible":
      return createOpenAICompatibleAdapter(config);
    case "anthropic":
      return createAnthropicAdapter(config);
    case "openai":
      return createOpenAIResponsesAdapter(config);
    case "openrouter":
      throw new Error(`Adapter "${config.adapter}" is not implemented yet`);
    default:
      throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}

/**
 * Whether a stream event represents partial output. Start and error events
 * are not "output" — they don't count as having emitted content to the caller.
 * This gate controls the "no retry after output" contract: once any text,
 * reasoning, tool_call, custom, usage, or end event is yielded, the stream
 * cannot be retried because the caller may have already acted on the content.
 */
function isPartialOutputEvent(event: StreamEvent): boolean {
  return event.type !== "start" && event.type !== "error";
}

/**
 * Race the next iterator value against an abort signal. This is the low-level
 * mechanism that makes timeouts and cancellations interrupt a mid-flight
 * provider stream. Without this race, the gateway would block on the
 * provider's HTTP response body until it self-terminates.
 *
 * Uses Promise.race with an abort-triggered rejection. The event listener is
 * cleaned up in the finally block so the AbortSignal doesn't accumulate
 * dangling listeners across many streamed events.
 */
async function nextStreamEvent(
  iterator: AsyncIterator<StreamEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<StreamEvent>> {
  if (signal.aborted) throw signal.reason ?? new Error("Request aborted");

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Stream with exponential-backoff retry for a single provider.
 *
 * Lifecycle per attempt:
 * 1. Create a derived AbortSignal (createModelAttemptSignal) that combines the
 *    parent request.signal with a wall-clock attempt timeout.
 * 2. Start the adapter stream and iterate events via nextStreamEvent.
 * 3. If an `error` event arrives before any output, and it's retryable, and
 *    attempts remain: break the inner loop, sleep with backoff, retry.
 * 4. If an error arrives after output, or it's non-retryable, or attempts are
 *    exhausted: yield the error and return immediately — no retry.
 * 5. If the iterator throws (network error, SDK exception): wrap as error
 *    event and apply the same retry logic.
 * 6. In the finally block: call iterator.return() to release provider
 *    resources, then cleanup() to clear the timeout timer.
 *
 * The `emittedOutput` flag enforces the invariant that retry only happens
 * before any content has been yielded to the caller. This prevents duplicate
 * content when the same request is retried.
 */
async function* streamWithRetry(
  adapter: ProviderAdapter,
  request: GenerateRequest,
  model: ModelInfo,
  retry: GatewayConfig["retry"],
  attemptTimeoutMs: number,
): AsyncGenerator<StreamEvent> {
  const maxAttempts = retry?.maxAttempts ?? 1;
  let delay = retry?.initialDelayMs ?? 500;
  const maxDelay = retry?.maxDelayMs ?? 10_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sawError: StreamEvent | undefined;
    let emittedOutput = false;
    const attemptSignal = createModelAttemptSignal(request.signal, attemptTimeoutMs);
    const iterator = adapter
      .stream({ ...request, signal: attemptSignal.signal }, model)
      [Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextStreamEvent(iterator, attemptSignal.signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === "error") {
          // If the attempt was killed by the deadline timer, surface that
          // timeout event (retryable) instead of whatever the SDK emitted.
          sawError = modelAttemptTimeoutEvent(attemptSignal.signal) ?? event;
          if (emittedOutput || !sawError.retryable || attempt >= maxAttempts) {
            yield sawError;
            return;
          }
          break;
        }
        yield event;
        emittedOutput ||= isPartialOutputEvent(event);
        if (event.type === "end") return;
      }
    } catch (error) {
      // Exceptions from nextStreamEvent — network drops, SDK errors, parent
      // aborts. Timeout errors are classified as retryable; parent aborts
      // (user cancellation) are not retryable.
      sawError = modelAttemptTimeoutEvent(attemptSignal.signal) ?? {
        type: "error",
        code: request.signal?.aborted ? "invalid_request" : "provider_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      if (emittedOutput || !sawError.retryable || attempt >= maxAttempts) {
        yield sawError;
        return;
      }
    } finally {
      // Release provider stream resources and clear the timeout timer.
      // iterator.return() may fail if the stream is already closed — that's fine.
      await iterator.return?.().catch(() => undefined);
      attemptSignal.cleanup();
    }

    if (sawError?.type === "error") {
      if (sawError.retryable && attempt < maxAttempts) {
        // Exponential backoff: wait before retrying, respecting parent abort.
        await sleep(delay, request.signal);
        delay = Math.min(delay * 2, maxDelay);
        continue;
      }
      yield sawError;
      return;
    }
    return;
  }
}

/**
 * Stream for a specific provider, resolving the model from the registry.
 * Handles error cases: no model specified, model not served by this provider,
 * no adapter registered.
 */
async function* streamForProvider(
  registry: ProviderRegistry,
  providerId: string,
  request: GenerateRequest,
  defaultModel: string | undefined,
  retry: GatewayConfig["retry"],
  attemptTimeoutMs: number,
): AsyncGenerator<StreamEvent> {
  const modelId = request.model ?? defaultModel;
  if (!modelId) {
    yield {
      type: "error",
      code: "invalid_request",
      message: "No model specified",
      retryable: false,
    };
    return;
  }

  const entry = registry.modelsById.get(modelId);
  if (!entry || entry.providerId !== providerId) {
    yield {
      type: "error",
      code: "invalid_request",
      message: `Provider ${providerId} does not serve model ${modelId}`,
      retryable: false,
    };
    return;
  }

  const adapter = registry.adapters.get(providerId);
  if (!adapter) {
    yield {
      type: "error",
      code: "invalid_request",
      message: `No adapter for provider ${providerId}`,
      retryable: false,
    };
    return;
  }

  yield* streamWithRetry(adapter, request, entry.model, retry, attemptTimeoutMs);
}

export function createGateway(config: GatewayConfig): Gateway {
  const adapters = new Map<string, ProviderAdapter>();
  for (const provider of config.providers) {
    adapters.set(provider.id, createAdapter(provider));
  }
  const registry = buildProviderRegistry(config.providers, adapters, {
    onWarning: config.onTrace,
  });

  const gateway: Gateway = {
    async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
      const retry = config.retry;
      const fallback = config.fallback;
      const attemptTimeoutMs = config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;

      // ── No fallback: single-provider path ──
      // Resolve the primary route and stream with retry. Routing errors
      // (unknown model, missing adapter) are surfaced as non-retryable
      // invalid_request errors.
      if (!fallback?.enabled) {
        try {
          const route = resolveRoute(registry, request, config.defaultModel);
          yield* streamWithRetry(route.adapter, request, route.model, retry, attemptTimeoutMs);
        } catch (err) {
          yield {
            type: "error",
            code: "invalid_request",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          };
        }
        return;
      }

      // ── Fallback: multi-provider path ──
      // Build the ordered fallback chain (primary first, then config.order or
      // registry order). For each provider in the chain:
      //   - Stream events. If output was emitted before the error,
      //     propagate the error immediately (no fallback).
      //   - On retryable error with no output emitted: move to next provider.
      //   - On non-retryable error: yield and return.
      // If all providers fail, yield the last error.
      const providerIds = fallbackProviderIds(
        registry,
        request,
        config.defaultModel,
        fallback.order,
      );

      let lastError: StreamEvent | undefined;
      for (const providerId of providerIds) {
        let failed = false;
        let emittedOutput = false;
        for await (const event of streamForProvider(
          registry,
          providerId,
          request,
          config.defaultModel,
          retry,
          attemptTimeoutMs,
        )) {
          if (event.type === "error") {
            lastError = event;
            if (emittedOutput) {
              yield event;
              return;
            }
            failed = event.retryable;
            break;
          }
          yield event;
          emittedOutput ||= isPartialOutputEvent(event);
          if (event.type === "end") return;
        }
        if (!failed) return;
      }

      if (lastError) yield lastError;
    },

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return consumeStream(gateway.stream(request));
    },

    listModels(): ModelInfo[] {
      return [...registry.modelsById.values()].map((e) => e.model);
    },

    getDefaultModel(): string | undefined {
      return config.defaultModel;
    },
  };

  return gateway;
}
