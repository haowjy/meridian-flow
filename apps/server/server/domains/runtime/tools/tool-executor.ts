import type { ModelEditKey } from "@meridian/contracts/drafts";
import {
  type MeridianError,
  meridianErrorFromTool,
  meridianErrorToJson,
  TOOL_EXCEPTION_CODE,
  TOOL_NOT_RUN_CODE,
} from "@meridian/contracts/errors";
import { isReturnResultOutcome } from "@meridian/contracts/spawn";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import { modelEditIds } from "../../../shared/model-edit-ids.js";
import type { CommandResolver } from "../ports/command-resolver.js";
import {
  invalidArgumentsResult,
  parseToolInput,
  renderInvalidArguments,
} from "./invalid-arguments.js";
import { isMeridianErrorValue, renderRefusal } from "./refusal.js";
import { jsonContent, textContent } from "./tool-content.js";
import type {
  ModelEditHandlerResult,
  RequestToolHandlerContext,
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

export function toolFailureResult(result: { ok: false; error: MeridianError }) {
  return { isError: true, output: meridianErrorToJson(result.error) };
}

function errorResult(toolCallId: string, error: MeridianError): ToolExecutionResult {
  const value = meridianErrorToJson(error);
  return { toolCallId, content: textContent(renderRefusal(value)), result: value, isError: true };
}

export function didNotRunResult(toolCallId: string): ToolExecutionResult {
  return errorResult(
    toolCallId,
    meridianErrorFromTool(
      "This call did not run: it was stopped before it changed anything.",
      undefined,
      TOOL_NOT_RUN_CODE,
    ),
  );
}

const EXECUTION_ERROR_CODES: Partial<Record<ToolExecutionError["kind"], string>> = {
  exception: TOOL_EXCEPTION_CODE,
  timeout: "tool_timeout",
  arguments_parse: "tool_arguments_parse",
};

function executionErrorResult(
  toolCallId: string,
  registration: ToolRegistration | undefined,
  error: ToolExecutionError,
): ToolExecutionResult {
  if (error.kind === "abort") {
    return errorResult(
      toolCallId,
      meridianErrorFromTool(error.message, undefined, TOOL_NOT_RUN_CODE),
    );
  }
  if (registration?.formatExecutionError) {
    try {
      return {
        toolCallId,
        ...modelOutput(
          registration,
          toJsonValue(registration.formatExecutionError(error)),
          inputObject(error.arguments),
        ),
        isError: true,
      };
    } catch {
      // A formatter must not break the executor's guarantee that tool failures resolve.
    }
  }
  return errorResult(
    toolCallId,
    meridianErrorFromTool(error.message, undefined, EXECUTION_ERROR_CODES[error.kind]),
  );
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

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

function isStructuredHandlerResult(
  value: unknown,
): value is { output: unknown; metadata?: Record<string, unknown> } {
  return typeof value === "object" && value !== null && "output" in value && !("isError" in value);
}

export function handlerToolResult(
  output: unknown,
  registration: ToolRegistration,
  input: JsonObject,
): Omit<ToolExecutionResult, "toolCallId"> {
  const evidence = hostEvidence(output);
  if (isModelEditHandlerResult(output)) {
    if (output.modelEdit.status === "never") {
      const { toolCallId: _, ...ranNot } = didNotRunResult("");
      return ranNot;
    }
    const { toolCallId: _, ...stored } = output.modelEdit.result.toolResult;
    return { ...stored, ...evidence };
  }
  if (isHandlerErrorResult(output)) {
    return {
      ...modelOutput(registration, toJsonValue(withoutHostOnly(output.output)), input),
      isError: true,
      ...evidence,
    };
  }
  let value = output;
  let metadata: JsonObject | undefined;
  if (isStructuredHandlerResult(output)) {
    value = output.output;
    if (output.metadata) metadata = toJsonValue(output.metadata) as JsonObject;
  }
  value = withoutHostOnly(value);
  return {
    ...modelOutput(registration, toJsonValue(value), input),
    ...(metadata ? { metadata } : {}),
    ...(registration.capability === "return_result" && isReturnResultOutcome(value)
      ? { returnResult: value }
      : {}),
    ...evidence,
  };
}

function isModelEditHandlerResult(value: unknown): value is ModelEditHandlerResult {
  return typeof value === "object" && value !== null && "modelEdit" in value;
}

const HOST_ONLY = ["evidence", "showing", "frontier"] as const;

function withoutHostOnly(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (!HOST_ONLY.some((key) => key in value)) return value;
  const rest = { ...(value as Record<string, unknown>) };
  for (const key of HOST_ONLY) delete rest[key];
  return rest;
}

function hostEvidence(output: unknown): Pick<ToolExecutionResult, "evidence"> {
  if (typeof output !== "object" || output === null || !("evidence" in output)) return {};
  const evidence = (output as Pick<ToolExecutionResult, "evidence">).evidence;
  return evidence && (evidence.shown.length > 0 || evidence.frontier || evidence.names)
    ? { evidence }
    : {};
}

function modelOutput(
  registration: ToolRegistration,
  value: JsonValue,
  input: JsonObject,
): Pick<ToolExecutionResult, "content" | "result"> {
  const content = isMeridianErrorValue(value)
    ? textContent(renderRefusal(value))
    : (registration.renderResult?.(value, input) ?? jsonContent(value));
  return { content, result: value };
}

function inputObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  return typeof json === "object" && json !== null && !Array.isArray(json) ? json : {};
}

function abortOutcome(signal: AbortSignal | undefined): Promise<{ aborted: true }> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  });
}

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

function isSequentialTool(registry: ToolRegistry, name: string): boolean {
  return registry.getRegistration(name)?.sequential === true;
}

function handlerContextForRegistration(
  registration: Exclude<ReturnType<ToolRegistry["getRegistration"]>, undefined>,
  baseContext: ToolHandlerContext,
  executionContext: ToolExecutionContext,
):
  | ToolHandlerContext
  | SpawnToolHandlerContext
  | ThreadMessageToolHandlerContext
  | ThreadReportToolHandlerContext
  | ReturnResultToolHandlerContext
  | RequestToolHandlerContext {
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
    case "request":
      if (!executionContext.request)
        throw new Error(`Request tool ${registration.definition.name} missing request context`);
      return { ...baseContext, request: executionContext.request };
  }
}

type CallExit = { exit: ToolExecutionError };

export function createToolExecutor(
  registry: ToolRegistry,
  commands?: CommandResolver,
): ToolExecutorWithBatch {
  function commandKey(
    registration: ToolRegistration | undefined,
    call: ToolCallInput,
    ctx: ToolExecutionContext,
  ): ModelEditKey | undefined {
    if (!registration?.documentCommand) return undefined;
    if (!commands || !ctx.responseIdentity || !ctx.commandOwner)
      throw new Error(`Tool ${call.name} is a document command and has no command context`);
    return {
      responseId: ctx.responseIdentity.modelResponseId,
      toolCallId: call.id,
      threadId: ctx.threadId,
      ...ctx.commandOwner,
    };
  }

  async function settleExit(
    call: ToolCallInput,
    registration: ToolRegistration | undefined,
    key: ModelEditKey | undefined,
    exit: ToolExecutionError,
  ): Promise<ToolExecutionResult> {
    const unsettled = executionErrorResult(call.id, registration, exit);
    if (!key || !commands) return unsettled;
    const outcome = await commands.resolveCommand(key);
    const blockId = modelEditIds(key).blockId;
    return outcome.status === "never"
      ? { ...unsettled, blockId }
      : { ...outcome.result.toolResult, blockId };
  }

  async function attempt(
    call: ToolCallInput,
    ctx: ToolExecutionContext,
    registration: ToolRegistration | undefined,
    key: ModelEditKey | undefined,
  ): Promise<ToolExecutionResult | CallExit> {
    const blockId = key ? modelEditIds(key).blockId : undefined;
    const ran = (result: Omit<ToolExecutionResult, "toolCallId">): ToolExecutionResult => ({
      toolCallId: call.id,
      ...result,
      ...(blockId ? { blockId } : {}),
    });
    try {
      if (!registration) {
        return errorResult(call.id, meridianErrorFromTool(`Tool not found: ${call.name}`));
      }

      if (registration.execution.type === "client") {
        return errorResult(call.id, meridianErrorFromTool("Client tool dispatch not implemented"));
      }

      if (call.argumentsParseError) {
        const { raw, message } = call.argumentsParseError;
        const fragment = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
        return executionErrorResult(call.id, registration, {
          kind: "arguments_parse",
          message: `Tool arguments for "${call.name}" were not valid JSON and could not be parsed or repaired (${message}). Received: ${fragment}`,
          arguments: call.arguments,
        });
      }

      let input: unknown = call.arguments;
      if (registration.input) {
        const parsed = parseToolInput(registration.input, call.arguments);
        if (!parsed.ok) {
          return {
            toolCallId: call.id,
            content: textContent(renderInvalidArguments(call.name, parsed.issues)),
            result: toJsonValue(invalidArgumentsResult(parsed.issues)),
            isError: true,
          };
        }
        input = parsed.value;
      }

      if (ctx.signal?.aborted) {
        return executionErrorResult(call.id, registration, {
          kind: "abort",
          message: "Tool aborted",
          arguments: call.arguments,
        });
      }

      const handlerContext: ToolHandlerContext = {
        signal: ctx.signal ?? new AbortController().signal,
        toolCallId: call.id,
        threadId: ctx.threadId as string,
        turnId: ctx.turnId as string,
        responseIdentity: ctx.responseIdentity,
        agentSlug: ctx.agentSlug,
        ...(ctx.frontiers ? { frontiers: ctx.frontiers } : {}),
        ...(ctx.shownNames ? { shownNames: ctx.shownNames } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        emitOutputDelta: ctx.emitOutputDelta
          ? (chunk) => ctx.emitOutputDelta?.(call.id, chunk)
          : undefined,
        ...(ctx.emitConnectionCall
          ? { emitConnectionCall: (event) => ctx.emitConnectionCall?.(call.id, event) }
          : {}),
        ...(key
          ? {
              modelEdit: {
                key,
                render(raw) {
                  const { evidence, ...rendered } = handlerToolResult(
                    raw,
                    registration,
                    inputObject(input),
                  );
                  return { toolResult: { toolCallId: call.id, ...rendered }, evidence };
                },
              },
            }
          : {}),
      };
      const effectiveHandlerContext = handlerContextForRegistration(
        registration,
        handlerContext,
        ctx,
      );

      if (registration.timeoutMs !== undefined) {
        const outcome = await runWithTimeout(
          registration.execution.handler as ToolHandler,
          input,
          effectiveHandlerContext,
          registration.timeoutMs,
          ctx.signal,
        );
        if ("aborted" in outcome) {
          return { exit: { kind: "abort", message: "Tool aborted", arguments: call.arguments } };
        }
        if (outcome.timedOut) {
          return {
            exit: {
              kind: "timeout",
              message: `Tool timed out after ${registration.timeoutMs}ms`,
              arguments: call.arguments,
            },
          };
        }
        return ran(handlerToolResult(outcome.result, registration, inputObject(input)));
      }

      const handler = registration.execution.handler as (
        input: unknown,
        context: typeof effectiveHandlerContext,
      ) => Promise<unknown>;
      const handlerPromise = handler(input, effectiveHandlerContext).then((result) => ({
        result,
      }));
      const abortPromise = abortOutcome(ctx.signal);
      const outcome = await Promise.race(
        abortPromise ? [handlerPromise, abortPromise] : [handlerPromise],
      );
      if ("aborted" in outcome) {
        return { exit: { kind: "abort", message: "Tool aborted", arguments: call.arguments } };
      }
      return ran(handlerToolResult(outcome.result, registration, inputObject(input)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { exit: { kind: "exception", message, arguments: call.arguments } };
    }
  }

  async function executeTool(
    call: ToolCallInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const registration = registry.getRegistration(call.name);
    const key = commandKey(registration, call, ctx);
    const attempted = await attempt(call, ctx, registration, key);
    return "exit" in attempted ? settleExit(call, registration, key, attempted.exit) : attempted;
  }

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
