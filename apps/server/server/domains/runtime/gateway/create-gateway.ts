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
 * - nextStreamEvent() races the iterator against the attempt signal for
 *   deadline timeouts and pre-output parent aborts.
 * - After partial output, user/disconnect cancel drains the adapter to a
 *   terminal partial `end` instead of synthesizing an immediate error.
 * - The finally block calls iterator.return() to release provider stream
 *   resources, then cleanup() to clear the timeout timer.
 */
import { createAnthropicAdapter } from "./adapters/anthropic/adapter.js";
import { createOpenAIResponsesAdapter } from "./adapters/openai/adapter.js";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible/adapter.js";
import { createOpenRouterAdapter } from "./adapters/openrouter/adapter.js";
import { settleOpenRouterCancelledResult } from "./adapters/openrouter/cancel-settlement.js";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  resolveOpenRouterApiKey,
} from "./adapters/openrouter/config.js";
import { consumeStream } from "./consume-stream.js";
import {
  createModelAttemptSignal,
  getModelAttemptTimeout,
  modelAttemptTimeoutEvent,
} from "./deadline.js";
import { settleGenericCancelledResult } from "./domain/cancel-settlement.js";
import type {
  CancelledResultSettlement,
  CancelledResultSettlementInput,
  GatewayConfig,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import {
  buildProviderRegistry,
  fallbackProviderIds,
  type ProviderRegistry,
  type ResolvedRoute,
  resolveRoute,
  resolveRouteForProvider,
} from "./routing.js";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
/** Wall-clock bound for post-output cancel drain — providers that ignore abort must not hang forever. */
const CANCEL_DRAIN_TIMEOUT_MS = 5_000;

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

/** Maps a ProviderConfig.adapter string to its concrete ProviderAdapter factory. */
function createAdapter(config: GatewayConfig["providers"][number]): ProviderAdapter {
  switch (config.adapter) {
    case "openai-compatible":
      return createOpenAICompatibleAdapter(config);
    case "openrouter":
      return createOpenRouterAdapter(config);
    case "anthropic":
      return createAnthropicAdapter(config);
    case "openai":
      return createOpenAIResponsesAdapter(config);
    default:
      throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}

function resolveSettlementProvider(
  registry: ProviderRegistry,
  input: CancelledResultSettlementInput,
  defaultModel: string | undefined,
): ProviderConfig | undefined {
  if (input.result) {
    return registry.providers.find((provider) => provider.id === input.result?.provider);
  }

  try {
    return resolveRoute(registry, { model: input.model, messages: [] }, defaultModel)
      .providerConfig;
  } catch {
    return undefined;
  }
}

async function settleCancelledResultForGateway(
  registry: ProviderRegistry,
  input: CancelledResultSettlementInput,
  defaultModel: string | undefined,
): Promise<CancelledResultSettlement | null> {
  const providerConfig = resolveSettlementProvider(registry, input, defaultModel);
  if (providerConfig?.adapter === "openrouter") {
    const apiKey = resolveOpenRouterApiKey(providerConfig.auth);
    return settleOpenRouterCancelledResult({
      ...input,
      model: input.result?.model ?? input.model,
      provider: providerConfig.id,
      baseUrl: providerConfig.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  return settleGenericCancelledResult(input);
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

function shouldDrainUserCancel(
  request: GenerateRequest,
  attemptSignal: AbortSignal,
  emittedOutput: boolean,
): boolean {
  return Boolean(
    emittedOutput && request.signal?.aborted && getModelAttemptTimeout(attemptSignal) === null,
  );
}

async function drainCancelledAdapterEvents(
  iterator: AsyncIterator<StreamEvent>,
  deadlineMs = CANCEL_DRAIN_TIMEOUT_MS,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const deadline = Date.now() + deadlineMs;
  let timedOut = false;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const raced = await Promise.race([
        iterator.next().then((result) => ({ kind: "next" as const, result })),
        sleep(remaining).then(() => ({ kind: "timeout" as const })),
      ]);

      if (raced.kind === "timeout") {
        timedOut = true;
        break;
      }

      const drained = raced.result;
      if (drained.done) break;
      events.push(drained.value);
      if (drained.value.type === "end" || drained.value.type === "error") break;
    }
  } catch {
    // Adapter already closed.
  }

  if (timedOut) {
    await iterator.return?.().catch(() => undefined);
  }

  return events;
}

async function* yieldDrainedCancelEvents(
  iterator: AsyncIterator<StreamEvent>,
): AsyncGenerator<StreamEvent, StreamEvent | undefined> {
  for (const event of await drainCancelledAdapterEvents(iterator)) {
    yield event;
    if (event.type === "end" || event.type === "error") {
      return event;
    }
  }
  return undefined;
}

type InFlightNextResult =
  | { kind: "next"; result: IteratorResult<StreamEvent> }
  | { kind: "drain_budget_exhausted" };

/**
 * Read the next adapter event. Parent cancel after partial output races the
 * in-flight iterator.next() against a drain deadline so providers that ignore
 * abort cannot hang forever. Attempt timeouts still hard-interrupt via a narrow
 * race that only rejects on ModelAttemptTimeoutError.
 */
async function boundedInFlightNext(
  waitForNext: Promise<IteratorResult<StreamEvent>>,
  iterator: AsyncIterator<StreamEvent>,
  deadlineMs = CANCEL_DRAIN_TIMEOUT_MS,
): Promise<InFlightNextResult> {
  const raced = await Promise.race([
    waitForNext.then((result) => ({ kind: "next" as const, result })),
    sleep(deadlineMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (raced.kind === "timeout") {
    await iterator.return?.().catch(() => undefined);
    return { kind: "drain_budget_exhausted" };
  }
  return { kind: "next", result: raced.result };
}

function attemptTimeoutRace(attemptSignal: AbortSignal): Promise<IteratorResult<StreamEvent>> {
  return new Promise<IteratorResult<StreamEvent>>((_, reject) => {
    const onAttemptAbort = () => {
      const timeout = getModelAttemptTimeout(attemptSignal);
      if (timeout) reject(timeout);
    };
    if (attemptSignal.aborted) onAttemptAbort();
    else attemptSignal.addEventListener("abort", onAttemptAbort, { once: true });
  });
}

type NextStreamEventResult =
  | { kind: "next"; result: IteratorResult<StreamEvent> }
  | { kind: "drain_budget_exhausted" };

async function nextStreamEvent(
  iterator: AsyncIterator<StreamEvent>,
  attemptSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
  emittedOutput: boolean,
): Promise<NextStreamEventResult> {
  if (parentSignal?.aborted && !emittedOutput) {
    throw parentSignal.reason ?? new Error("Request aborted");
  }

  const waitForNext = iterator.next();

  if (emittedOutput && parentSignal) {
    if (parentSignal.aborted) {
      return boundedInFlightNext(waitForNext, iterator);
    }

    return await Promise.race([
      waitForNext.then((result) => ({ kind: "next" as const, result })),
      attemptTimeoutRace(attemptSignal).then((result) => ({ kind: "next" as const, result })),
      new Promise<NextStreamEventResult>((resolve) => {
        parentSignal.addEventListener(
          "abort",
          () => {
            void boundedInFlightNext(waitForNext, iterator).then(resolve);
          },
          { once: true },
        );
      }),
    ]);
  }

  const result = await Promise.race([waitForNext, attemptTimeoutRace(attemptSignal)]);
  return { kind: "next", result };
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
        const nextResult = await nextStreamEvent(
          iterator,
          attemptSignal.signal,
          request.signal,
          emittedOutput,
        );
        if (nextResult.kind === "drain_budget_exhausted") {
          break;
        }
        const next = nextResult.result;
        if (next.done) {
          if (shouldDrainUserCancel(request, attemptSignal.signal, emittedOutput)) {
            const terminal = yield* yieldDrainedCancelEvents(iterator);
            if (terminal?.type === "end") return;
            if (terminal?.type === "error") return;
          }
          break;
        }
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
      const timeoutEvent = modelAttemptTimeoutEvent(attemptSignal.signal);
      if (timeoutEvent) {
        sawError = timeoutEvent;
      } else if (emittedOutput && request.signal?.aborted) {
        const terminal = yield* yieldDrainedCancelEvents(iterator);
        if (terminal?.type === "end") return;
        if (terminal?.type === "error") {
          sawError = terminal;
        } else {
          return;
        }
      } else {
        sawError = {
          type: "error",
          code: request.signal?.aborted ? "invalid_request" : "provider_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
      }
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

  let route: ResolvedRoute;
  try {
    route = resolveRouteForProvider(registry, providerId, modelId);
  } catch (err) {
    yield {
      type: "error",
      code: "invalid_request",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
    return;
  }

  yield* streamWithRetry(route.adapter, request, route.model, retry, attemptTimeoutMs);
}

export function createGateway(config: GatewayConfig): Gateway {
  const adapters = new Map<string, ProviderAdapter>();
  for (const provider of config.providers) {
    adapters.set(provider.id, createAdapter(provider));
  }
  const registry = buildProviderRegistry(config.providers, adapters, {
    onWarning: config.onWarning,
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

    async settleCancelledResult(
      input: CancelledResultSettlementInput,
    ): Promise<CancelledResultSettlement | null> {
      return settleCancelledResultForGateway(registry, input, config.defaultModel);
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
