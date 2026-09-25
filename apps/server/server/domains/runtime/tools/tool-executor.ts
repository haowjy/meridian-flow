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
 *   - Throwing an exception → caught, then formatted by the registration or
 *     normalized to MeridianError with `isError: true`
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
 * This two-phase approach prevents document mutations (write) from
 * interleaving with other tool calls.
 * The original array index is preserved so the orchestrator can map results
 * back to the model's output item order.
 */
import {
  type MeridianError,
  meridianErrorFromTool,
  meridianErrorToJson,
} from "@meridian/contracts/interrupt";
import { isReturnResultOutcome } from "@meridian/contracts/spawn";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import type {
  InterruptToolHandlerContext,
  ReturnResultToolHandlerContext,
  SpawnToolHandlerContext,
  ThreadMessageToolHandlerContext,
  ThreadReportToolHandlerContext,
  ToolCallInput,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
  ToolExecutor,
  ToolHandler,
  ToolHandlerContext,
  ToolRegistration,
  ToolRegistry,
} from "./types.js";

export type ToolExecutorWithBatch = ToolExecutor & {
  executeTools(calls: ToolCallInput[], ctx: ToolExecutionContext): Promise<ToolExecutionResult[]>;
};

/**
 * Constructs the default MeridianError result for a tool call that failed.
 */
function errorResult(toolCallId: string, error: MeridianError): ToolExecutionResult {
  return { toolCallId, output: meridianErrorToJson(error), isError: true };
}

function executionErrorResult(
  toolCallId: string,
  registration: ToolRegistration | undefined,
  error: ToolExecutionError,
): ToolExecutionResult {
  if (registration?.formatExecutionError) {
    try {
      return {
        toolCallId,
        output: toJsonValue(registration.formatExecutionError(error)),
        isError: true,
      };
    } catch {
      // A formatter must not break the executor's guarantee that tool failures resolve.
    }
  }
  return errorResult(toolCallId, meridianErrorFromTool(error.message));
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
function isHandlerErrorResult(value: unknown): value is {
  isError: true;
  output: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true &&
    "output" in value
  );
}

/**
 * Type guard for handlers that return structured output with optional metadata.
 * Pattern: `{ output: unknown, metadata?: Record<string, unknown> }`.
 * Distinct from error results (which have `isError: true`).
 */
function isStructuredHandlerResult(
  value: unknown,
): value is { output: unknown; metadata?: Record<string, unknown> } {
  return typeof value === "object" && value !== null && "output" in value && !("isError" in value);
}

/**
 * Normalizes a handler return value into a `ToolExecutionResult`.
 * Handler-owned errors keep their JSON value verbatim while the executor
 * forwards `isError`. Thrown and executor-owned failures use the registration's
 * formatter or the generic Meridian error protocol.
 */
function successResult(
  toolCallId: string,
  output: unknown,
  capability?: ToolRegistration["capability"],
): ToolExecutionResult {
  if (isHandlerErrorResult(output)) {
    return { toolCallId, output: toJsonValue(output.output), isError: true };
  }
  let value = output;
  let metadata: JsonObject | undefined;
  if (isStructuredHandlerResult(output)) {
    value = output.output;
    if (output.metadata) metadata = toJsonValue(output.metadata) as JsonObject;
  }
  return {
    toolCallId,
    output: toJsonValue(value),
    ...(metadata ? { metadata } : {}),
    ...(capability === "return_result" && isReturnResultOutcome(value)
      ? { returnResult: value }
      : {}),
  };
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

/** Races a tool handler against its timeout and the caller's abort signal. */
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

/** Returns whether the registered tool must run alone. */
function isSequentialTool(registry: ToolRegistry, name: string): boolean {
  return registry.getRegistration(name)?.sequential === true;
}

function handlerContextForRegistration(
  registration: Exclude<ReturnType<ToolRegistry["getRegistration"]>, undefined>,
  baseContext: ToolHandlerContext,
  executionContext: ToolExecutionContext,
):
  | ToolHandlerContext
  | InterruptToolHandlerContext
  | SpawnToolHandlerContext
  | ThreadMessageToolHandlerContext
  | ThreadReportToolHandlerContext
  | ReturnResultToolHandlerContext {
  switch (registration.capability) {
    case undefined:
      return baseContext;
    case "spawn":
      if (!executionContext.spawn) {
        throw new Error(`Spawn tool ${registration.definition.name} missing spawn context`);
      }
      return { ...baseContext, spawn: executionContext.spawn };
    case "thread_message":
      if (!executionContext.threadMessage) {
        throw new Error(
          `Thread-message tool ${registration.definition.name} missing threadMessage context`,
        );
      }
      return { ...baseContext, threadMessage: executionContext.threadMessage };
    case "thread_report":
      if (!executionContext.threadReport)
        throw new Error(
          `Thread-report tool ${registration.definition.name} missing threadReport context`,
        );
      return { ...baseContext, threadReport: executionContext.threadReport };
    case "return_result":
      if (!executionContext.returnResult) {
        throw new Error(
          `Return-result tool ${registration.definition.name} missing returnResult context`,
        );
      }
      return { ...baseContext, returnResult: executionContext.returnResult };
    case "interrupt":
      if (!executionContext.interrupt || !executionContext.updateComponentBlock) {
        throw new Error(`Interrupt tool ${registration.definition.name} missing interrupt context`);
      }
      return {
        ...baseContext,
        interruptTimeoutMs: executionContext.interruptTimeoutMs ?? 270_000,
        interrupt: executionContext.interrupt,
        updateComponentBlock: executionContext.updateComponentBlock,
      };
  }
}

export function createToolExecutor(registry: ToolRegistry): ToolExecutorWithBatch {
  /** Dispatches one call and maps handler failures to tool results. */
  async function executeTool(
    call: ToolCallInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    let registration: ToolRegistration | undefined;
    try {
      registration = registry.getRegistration(call.name);
      if (!registration) {
        return errorResult(call.id, meridianErrorFromTool(`Tool not found: ${call.name}`));
      }

      if (registration.execution.type === "client") {
        return errorResult(call.id, meridianErrorFromTool("Client tool dispatch not implemented"));
      }

      if (call.argumentsParseError) {
        const { raw, message } = call.argumentsParseError;
        // Echo the offending fragment (truncated) so the model can see what it
        // emitted and self-correct — a clear JSON-parse error, never a misleading
        // downstream schema error like "path is required".
        const fragment = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
        return executionErrorResult(call.id, registration, {
          kind: "arguments_parse",
          message: `Tool arguments for "${call.name}" were not valid JSON and could not be parsed or repaired (${message}). Received: ${fragment} — re-send this tool call with only a valid JSON object (every string value, including hashes, must be quoted).`,
          arguments: call.arguments,
        });
      }

      if (ctx.signal?.aborted) {
        // Early-exit: the turn was already cancelled before we started.
        // This skips handler invocation entirely, avoiding wasted work.
        return executionErrorResult(call.id, registration, {
          kind: "abort",
          message: "Tool aborted",
          arguments: call.arguments,
        });
      }

      // Build the handler context. Use a dummy AbortController if no
      // external signal is provided — every handler must receive a signal
      // (the interface requires it), even if the caller doesn't supply one.
      const handlerContext: ToolHandlerContext = {
        signal: ctx.signal ?? new AbortController().signal,
        toolCallId: call.id,
        threadId: ctx.threadId as string,
        turnId: ctx.turnId as string,
        responseId: ctx.responseId,
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
          return executionErrorResult(call.id, registration, {
            kind: "abort",
            message: "Tool aborted",
            arguments: call.arguments,
          });
        }
        if (outcome.timedOut) {
          return executionErrorResult(call.id, registration, {
            kind: "timeout",
            message: `Tool timed out after ${registration.timeoutMs}ms`,
            arguments: call.arguments,
          });
        }
        return successResult(call.id, outcome.result, registration.capability);
      }

      const handler = registration.execution.handler as (
        input: unknown,
        context: typeof effectiveHandlerContext,
      ) => Promise<unknown>;
      const handlerPromise = handler(call.arguments, effectiveHandlerContext).then((result) => ({
        result,
      }));
      const abortPromise = abortOutcome(ctx.signal);
      const outcome = await Promise.race(
        abortPromise ? [handlerPromise, abortPromise] : [handlerPromise],
      );
      if ("aborted" in outcome) {
        return executionErrorResult(call.id, registration, {
          kind: "abort",
          message: "Tool aborted",
          arguments: call.arguments,
        });
      }
      return successResult(call.id, outcome.result, registration.capability);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return executionErrorResult(call.id, registration, {
        kind: "exception",
        message,
        arguments: call.arguments,
      });
    }
  }

  /**
   * Batch execution: splits calls into parallel and sequential phases.
   *
   * ── Why two phases ──
   *
   * Document mutations (`write`) are marked `sequential: true` because they
   * must not interleave with concurrent tool calls against the same file.
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
