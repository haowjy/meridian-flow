// @ts-nocheck
/**
 * Tool executor: looks up a tool by name in the registry and runs its handler
 * with execution context, normalizing results/errors (incl. batch execution).
 * Owns tool-call dispatch; depends inward on the tool types/registry.
 *
 * ── Execution model ──
 *
 * Every tool call is dispatched as a Promise that races three things:
 *
 *   1. The handler itself — `handler(input, context) => Promise<unknown>`
 *   2. A per-tool timeout timer (if the registration specifies `timeoutMs`)
 *   3. The caller's external abort signal (turn cancellation)
 *
 * The first to settle wins. If the timeout wins, the handler's AbortSignal
 * is aborted and the result is a timeout error. If the external abort wins,
 * the result is an abort error. If the handler wins, the return value is
 * normalized into a `ToolExecutionResult`.
 *
 * ── Error normalization ──
 *
 * Tool handlers can signal errors in two ways, both normalized by the executor:
 *   - Throwing an exception → caught, message extracted, `isError: true`
 *   - Returning `{ isError: true, output: JsonValue }` → recognized as a
 *     structured error, output extracted directly.
 *
 * The second path exists so that handlers backed by structured error types
 * (e.g. `ContextError` from the context domain) can surface detailed error
 * information through the execution result without throwing.
 *
 * All successful return values pass through `JSON.parse(JSON.stringify(...))`
 * to guarantee JSON-serializability — the downstream journal event pipeline
 * requires `JsonValue`.
 *
 * ── Batch execution (parallel + sequential) ──
 *
 * `executeTools` receives an array of `ToolCallInput` and splits them into
 * two phases:
 *   1. Parallel: all tools without `sequential: true` run concurrently via
 *      `Promise.all`. Results are placed at their original array indices.
 *   2. Sequential: tools with `sequential: true` run one-at-a-time in array
 *      order, after all parallel tools have completed.
 *
 * This two-phase approach prevents file mutations (edit, write) from
 * interleaving with reads and other pure tools.
 * The original array index is preserved so the orchestrator can map results
 * back to the model's output item order.
 */
import {
  isMeridianError,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
  meridianErrorToJson,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  CheckpointToolHandlerContext,
  ReturnResultToolHandlerContext,
  SpawnToolHandlerContext,
  ToolCallInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutor,
  ToolHandler,
  ToolHandlerContext,
  ToolRegistry,
} from "./types.js";

export type ToolExecutorWithBatch = ToolExecutor & {
  executeTools(calls: ToolCallInput[], ctx: ToolExecutionContext): Promise<ToolExecutionResult[]>;
};

/**
 * Constructs an error result envelope for a tool call that failed.
 * `output` is the error message as a plain `JsonValue` string.
 */
function errorResult(toolCallId: string, error: MeridianError): ToolExecutionResult {
  return { toolCallId, output: meridianErrorToJson(error), isError: true };
}

/**
 * Deep-serializes any value into `JsonValue` via round-trip through JSON.
 * This guarantees the output survives the journal event pipeline (which
 * writes to JSONB columns) and wire protocols (JSON.stringify).
 *
 * `undefined` maps to `null` because JSON has no undefined value — the
 * round-trip drops it, and we want a deterministic placeholder.
 */
function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Type guard that detects the structured error pattern:
 * `{ isError: true, output: JsonValue }`.
 *
 * Tool handlers backed by domain-layer error types (e.g. `ContextError`
 * from the context domain) can return this shape to signal a recoverable
 * error. The executor extracts the `output` field directly rather than
 * wrapping it in a generic error message.
 */
function isHandlerErrorResult(
  value: unknown,
): value is { isError: true; output: MeridianError | JsonValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true &&
    "output" in value
  );
}

/**
 * Normalizes a handler return value into a `ToolExecutionResult`.
 * If the handler returned a structured error (`{ isError: true, output: ... }`),
 * the output is used verbatim and `isError` is forwarded. Otherwise the
 * value is serialized through `toJsonValue` for JSON safety.
 */
function successResult(toolCallId: string, output: unknown): ToolExecutionResult {
  if (isHandlerErrorResult(output)) {
    const meridianError = isMeridianError(output.output)
      ? output.output
      : meridianErrorFromStructuredToolOutput(output.output as JsonValue);
    return { toolCallId, output: meridianErrorToJson(meridianError), isError: true };
  }
  return { toolCallId, output: toJsonValue(output) };
}

/**
 * Creates a Promise that resolves with `{ aborted: true }` when the given
 * signal fires. Returns `undefined` if no signal is provided, which the
 * caller uses to skip adding an abort arm to `Promise.race`.
 *
 * If the signal is already aborted at call time, returns a pre-resolved
 * Promise so the race completes synchronously (no microtask delay).
 */
function abortOutcome(signal: AbortSignal | undefined): Promise<{ aborted: true }> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  });
}

/**
 * Runs a tool handler with a per-tool wall-clock timeout.
 *
 * Creates a derived `AbortController` that merges the external abort signal
 * (turn cancellation) with the timeout abort. The handler receives this
 * merged signal via `context.signal`.
 *
 * Three-way race:
 *   1. `handlerPromise` — the handler completes normally
 *   2. `timeoutPromise` — the per-tool `timeoutMs` elapses
 *   3. `abortPromise` — the external signal fires (turn cancelled)
 *
 * The handler's rejections are silently ignored after the race settles
 * (`.catch(() => {})`) because the race winner already determined the
 * outcome — the loser's rejection is a predictable consequence of abort.
 *
 * The timeout timer is always cleared in the `finally` block to avoid
 * leaking a Node.js timer if the handler or external abort resolves first.
 */
async function runWithTimeout(
  handler: (input: unknown, context: ToolHandlerContext) => Promise<unknown>,
  input: unknown,
  handlerContext: ToolHandlerContext,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ timedOut: true } | { aborted: true } | { timedOut: false; result: unknown }> {
  const controller = new AbortController();
  const context: ToolHandlerContext = {
    ...handlerContext,
    signal: externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  try {
    const handlerPromise = handler(input, context).then((result) => ({
      timedOut: false as const,
      result,
    }));
    void handlerPromise.catch(() => {
      // Outcome is decided by the race; ignore late rejections (e.g. abort after timeout).
    });

    const abortPromise = abortOutcome(externalSignal);
    return await Promise.race(
      abortPromise
        ? [handlerPromise, timeoutPromise, abortPromise]
        : [handlerPromise, timeoutPromise],
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Checks whether a tool is flagged as sequential in the registry.
 * Returns `false` if the tool is not found (unknown tools can't be sequential).
 *
 * Separate from `getRegistration` so batch execution can query this property
 * without retrieving the full registration object for every call.
 */
function isSequentialTool(registry: ToolRegistry, name: string): boolean {
  try {
    return registry.getRegistration(name)?.sequential === true;
  } catch {
    return false;
  }
}

function handlerContextForRegistration(
  registration: Exclude<ReturnType<ToolRegistry["getRegistration"]>, undefined>,
  baseContext: ToolHandlerContext,
  executionContext: ToolExecutionContext,
):
  | ToolHandlerContext
  | CheckpointToolHandlerContext
  | SpawnToolHandlerContext
  | ReturnResultToolHandlerContext {
  switch (registration.capability) {
    case undefined:
      return baseContext;
    case "spawn":
      if (!executionContext.spawn) {
        throw new Error(`Spawn tool ${registration.definition.name} missing spawn context`);
      }
      return { ...baseContext, spawn: executionContext.spawn };
    case "return_result":
      if (!executionContext.returnResult) {
        throw new Error(
          `Return-result tool ${registration.definition.name} missing returnResult context`,
        );
      }
      return { ...baseContext, returnResult: executionContext.returnResult };
    case "checkpoint":
      if (!executionContext.checkpoint || !executionContext.updateComponentBlock) {
        throw new Error(
          `Checkpoint tool ${registration.definition.name} missing checkpoint context`,
        );
      }
      return {
        ...baseContext,
        checkpointTimeoutMs: executionContext.checkpointTimeoutMs ?? 270_000,
        checkpoint: executionContext.checkpoint,
        updateComponentBlock: executionContext.updateComponentBlock,
      };
  }
}

export function createToolExecutor(registry: ToolRegistry): ToolExecutorWithBatch {
  /**
   * Dispatches a single tool call.
   *
   * ── Flow ──
   *
   * 1. Look up the tool registration by name. Unknown tools → error.
   * 2. If the tool is client-type → error (not implemented).
   * 3. If already aborted → abort error (avoid starting new work).
   * 4. Build the `ToolHandlerContext` with the turn-level abort signal.
   * 5. If the registration has `timeoutMs`, race handler vs timeout vs abort.
   *    If no timeout, race handler vs abort only.
   * 6. Normalize the outcome into a `ToolExecutionResult`.
   *
   * Any uncaught exception from the handler is caught by the outer try/catch
   * and converted to an error result — the handler Promise rejection is not
   * surfaced through `Promise.race` because rejections are suppressed with
   * `.catch(() => {})` in both the timeout and non-timeout paths.
   */
  async function executeTool(
    call: ToolCallInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const registration = registry.getRegistration(call.name);
      if (!registration) {
        return errorResult(call.id, meridianErrorFromTool(`Tool not found: ${call.name}`));
      }

      if (registration.execution.type === "client") {
        // Client-side tool dispatch is defined at the type level but not yet
        // implemented. When it lands, the executor will emit a
        // "tool.client_waiting" event and suspend until the client responds
        // through the thread event hub. For now, client tools are unreachable.
        return errorResult(call.id, meridianErrorFromTool("Client tool dispatch not implemented"));
      }

      if (ctx.signal?.aborted) {
        // Early-exit: the turn was already cancelled before we started.
        // This skips handler invocation entirely, avoiding wasted work.
        return errorResult(call.id, meridianErrorFromTool("Tool aborted"));
      }

      // Build the handler context. Use a dummy AbortController if no
      // external signal is provided — every handler must receive a signal
      // (the interface requires it), even if the caller doesn't supply one.
      const handlerContext: ToolHandlerContext = {
        signal: ctx.signal ?? new AbortController().signal,
        threadId: ctx.threadId as string,
        turnId: ctx.turnId as string,
        agentSlug: ctx.agentSlug,
        emitOutputDelta: ctx.emitOutputDelta
          ? (chunk) => ctx.emitOutputDelta?.(call.id, chunk)
          : undefined,
      };
      const effectiveHandlerContext = handlerContextForRegistration(
        registration,
        handlerContext,
        ctx,
      );

      if (registration.timeoutMs !== undefined) {
        const outcome = await runWithTimeout(
          registration.execution.handler as ToolHandler,
          call.arguments,
          effectiveHandlerContext,
          registration.timeoutMs,
          ctx.signal,
        );
        if ("aborted" in outcome) {
          return errorResult(call.id, meridianErrorFromTool("Tool aborted"));
        }
        if (outcome.timedOut) {
          return errorResult(
            call.id,
            meridianErrorFromTool(`Tool timed out after ${registration.timeoutMs}ms`),
          );
        }
        return successResult(call.id, outcome.result);
      }

      // ── No per-tool timeout — race handler vs abort only ──
      //
      // This path exists separately from `runWithTimeout` because when no
      // `timeoutMs` is configured we don't need to create a timeout timer,
      // a derived AbortController, or a combined signal. The handler receives
      // the caller's signal directly for efficiency.
      const handler = registration.execution.handler as (
        input: unknown,
        context: typeof effectiveHandlerContext,
      ) => Promise<unknown>;
      const handlerPromise = handler(call.arguments, effectiveHandlerContext).then((result) => ({
        result,
      }));
      void handlerPromise.catch(() => {
        // Outcome may be decided by caller abort; ignore late rejections.
      });
      const abortPromise = abortOutcome(ctx.signal);
      const outcome = await Promise.race(
        abortPromise ? [handlerPromise, abortPromise] : [handlerPromise],
      );
      if ("aborted" in outcome) {
        return errorResult(call.id, meridianErrorFromTool("Tool aborted"));
      }
      return successResult(call.id, outcome.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(call.id, meridianErrorFromTool(message));
    }
  }

  /**
   * Batch execution: splits calls into parallel and sequential phases.
   *
   * ── Why two phases ──
   *
   * File mutations (edit, write) are marked
   * `sequential: true` because they must not interleave with concurrent
   * reads of the same files. Running them after all parallel tools ensures
   * that the model's read-before-edit pattern is safe: all reads complete
   * before any write begins.
   *
   * ── Index preservation ──
   *
   * Results are placed at the original array position via pre-allocated
   * `new Array(calls.length)`. This preserves the model's output-item order
   * so the orchestrator can pair results with the calls that produced them.
   *
   * ── Sequential execution order ──
   *
   * Sequential tools run in their original array order (left-to-right).
   * If the model emits `[write("a"), write("b")]`, "a" is written first.
   * This is a reasonable default — intra-batch tool ordering is not an
   * explicit model-level guarantee, but preserving left-to-right order
   * matches the model's own output sequence.
   */
  async function executeTools(
    calls: ToolCallInput[],
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult[]> {
    const indexed = calls.map((call, index) => ({ call, index }));
    const parallel = indexed.filter(({ call }) => !isSequentialTool(registry, call.name));
    const sequential = indexed.filter(({ call }) => isSequentialTool(registry, call.name));

    const results: ToolExecutionResult[] = new Array(calls.length);

    await Promise.all(
      parallel.map(async ({ call, index }) => {
        results[index] = await executeTool(call, ctx);
      }),
    );

    for (const { call, index } of sequential) {
      results[index] = await executeTool(call, ctx);
    }

    return results;
  }

  return { executeTool, executeTools, getDefinitions: () => registry.getDefinitions() };
}
