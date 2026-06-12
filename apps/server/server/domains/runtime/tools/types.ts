// @ts-nocheck
/**
 * Canonical tool-execution types: tool call inputs, handler/context shapes,
 * registry and executor interfaces. The vocabulary the registry, executor,
 * and thread-facing ports share.
 *
 * These types define the boundary between the model-runtime loop (which
 * produces tool calls from LLM output) and the tool handler implementations
 * (which are wired in by the composition root). They are deliberately narrow:
 * a tool handler is a narrow `(input, context) => Promise<unknown>` function.
 * The only streaming seam is the optional output-delta sink, which the
 * orchestrator injects for tools that stream live process output.
 */
import type { CheckpointAnswerEnvelope } from "@meridian/contracts/components";
import type { CheckpointRequest } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ReturnResultCapture, SpawnResult } from "@meridian/contracts/spawn";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import type { FunctionTool } from "../gateway/index.js";

// ── Payload types (tool call → execution) ──

/**
 * A single tool call produced by the model, ready for dispatch.
 *
 * `id` is the tool-call identifier assigned by the orchestrator (not the
 * provider). It is guaranteed unique within the turn and is used to match
 * results back to calls in journal events and UI projections.
 *
 * `arguments` is the parsed JSON object the model emitted for this call.
 * It is `Record<string, unknown>` rather than `JsonValue` because the
 * orchestration layer parses the model's JSON string before passing it here;
 * the executor never receives raw string arguments.
 */
export interface ToolCallInput {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Execution-scoped metadata passed by the orchestrator to the executor for
 * every batch of tool calls. Distinct from `ToolHandlerContext` — this is
 * the *outer* envelope the orchestrator uses to describe the execution
 * environment, not the per-handler context the tool handler sees.
 *
 * `signal` is the turn-level abort signal. When the user cancels a turn,
 * the orchestrator aborts this signal, and the executor races it against
 * every tool handler so in-flight work is abandoned promptly.
 */
export interface ToolExecutionContext {
  threadId: ThreadId;
  turnId: TurnId;
  agentSlug: string | null;
  signal?: AbortSignal;
  /**
   * Execution-scope live output sink. The executor binds the current
   * `ToolCallInput.id` before exposing this as the narrower per-handler
   * `ctx.emitOutputDelta(chunk)` callback.
   */
  emitOutputDelta?: (
    toolCallId: string,
    chunk: { stream: "stdout" | "stderr"; text: string },
  ) => void;
  checkpointTimeoutMs?: number;
  checkpoint?: CheckpointToolHandlerContext["checkpoint"];
  updateComponentBlock?: CheckpointToolHandlerContext["updateComponentBlock"];
  spawn?: SpawnToolHandlerContext["spawn"];
  returnResult?: ReturnResultToolHandlerContext["returnResult"];
}

/**
 * Normalized result envelope for a single tool execution.
 *
 * `toolCallId` matches `ToolCallInput.id` so the orchestrator can pair
 * results with their originating calls in journal events.
 *
 * `output` is always a JSON-serializable value — the executor runs every
 * handler return value through `JSON.parse(JSON.stringify(...))` to guarantee
 * it survives serialization into journal events and wire protocols.
 *
 * `isError` is a structured flag separate from `output`. A tool handler can
 * signal a recoverable error either by throwing (caught and converted by the
 * executor) or by returning `{ isError: true, output: ... }`. The executor
 * normalizes both paths into this flag so that downstream consumers
 * (orchestrator, UI) can distinguish tool errors from successful outputs
 * without inspecting the output shape.
 */
export interface ToolExecutionResult {
  toolCallId: string;
  output: JsonValue;
  isError?: boolean;
}

/**
 * The executor port: dispatches tool calls to registered handlers.
 *
 * `getDefinitions` is optional because the executor may not own the full
 * registry — in production the registry is created independently and the
 * orchestrator pulls definitions directly from it. The method exists for
 * callers that want a single-object interface (tests, CLI tools).
 */
export interface ToolExecutor {
  executeTool(call: ToolCallInput, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
  getDefinitions?(): FunctionTool[];
}

/**
 * The base context object passed into every tool handler invocation.
 *
 * Base handlers receive only execution identity, cancellation, and the narrow
 * stdout/stderr streaming sink. Interactive or orchestrator-adjacent powers are
 * explicit registration-declared capabilities: `checkpoint` receives the
 * user-input suspend/resume callbacks, `spawn` receives the nested-agent
 * launcher, and `return_result` receives the child-to-parent completion hook.
 * The executor enforces that capability declaration before injecting those
 * extensions, so ordinary handlers never see channels they did not request.
 */
export interface ToolHandlerContext {
  signal: AbortSignal;
  threadId: string;
  turnId: string;
  /** Mars agent slug from Thread.currentAgent; null when the thread has no bound agent. */
  agentSlug: string | null;
  /**
   * Optional live-output sink. The orchestrator injects this only for tools
   * that stream. Undefined for non-streaming handlers.
   */
  emitOutputDelta?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export type CheckpointResponse = CheckpointAnswerEnvelope;

/**
 * Richer context injected only for registrations with `capability: "checkpoint"`.
 * Checkpoint tools are still normal async handlers; these callbacks are the
 * narrow suspend/resume seam the orchestrator owns.
 */
export interface SpawnToolHandlerContext extends ToolHandlerContext {
  spawn(input: { agent: string; prompt: string; description?: string }): Promise<SpawnResult>;
}

export interface ReturnResultToolHandlerContext extends ToolHandlerContext {
  returnResult(capture: ReturnResultCapture): Promise<{ ok: true }>;
}

export interface CheckpointToolHandlerContext extends ToolHandlerContext {
  /** Effective timeout in milliseconds from workbench preferences unless the tool overrides it. */
  checkpointTimeoutMs: number;
  /**
   * Persist a component block, mark the turn as waiting_checkpoint, and
   * suspend until a user response or timeout resolves the checkpoint.
   */
  checkpoint(request: CheckpointRequest, timeoutMs?: number): Promise<CheckpointResponse>;
  /**
   * Patch the persisted component block's `props` after resolution so replay
   * and cold-load can render the selected value/provenance.
   */
  updateComponentBlock(checkpointId: string, propsPatch: JsonObject): Promise<void>;
}

/**
 * The core tool-handler type signature.
 *
 * `input` is typed as `unknown` rather than `Record<string, unknown>`
 * because the executor does not re-parse or validate the model's arguments
 * before passing them through — the handler is responsible for casting and
 * validating its own input. This is a pragmatic choice: the model's JSON
 * output is already parsed at the orchestrator layer, and per-tool JSON
 * Schema validation is deferred to individual handler implementations.
 *
 * The return type is `Promise<unknown>` — handlers are async by convention
 * (most do I/O), and the executor normalizes whatever they return through
 * `toJsonValue` so the downstream pipeline always receives `JsonValue`.
 */
export type ToolHandler<TContext extends ToolHandlerContext = ToolHandlerContext> = (
  input: unknown,
  context: TContext,
) => Promise<unknown>;

/**
 * A complete tool registration: the definition the model sees plus the
 * execution strategy and runtime constraints.
 *
 * Execution strategy (`execution.type`):
 *   - `"server"`: the handler runs inside the Meridian server process.
 *     The model may call this tool without any client round-trip.
 *   - `"client"`: execution is delegated to a client-side runtime
 *     (e.g. a browser or IDE plugin). The model emits the call, the
 *     orchestrator pauses and waits for the client to supply the result.
 *     Not yet implemented — client-type registrations currently produce
 *     an error result.
 *
 * `advertise`: when false, hides the registration from registry-wide default
 *   publication while preserving executor lookup. Used for per-agent skill
 *   tools: agent turn context advertises only resolved skills for that thread.
 *
 * `timeoutMs`: per-invocation wall-clock limit. When set, the executor
 *   races the handler against a timer; if the timer wins, the handler's
 *   AbortSignal is aborted and the result is marked as a timeout error.
 *   If not set, the only deadline is the caller's external `AbortSignal`.
 *
 * `sequential`: when `true`, this tool runs after all parallel tools in
 *   the same batch have completed. Used for tools that must not interleave
 *   with others (file mutation, shell commands).
 *
 * `capability`: declares the single privileged context extension this
 *   registration needs. The executor injects the corresponding callbacks from
 *   `ToolExecutionContext`; registrations without a capability receive only the
 *   base `ToolHandlerContext`.
 */
export interface ToolRegistration {
  /**
   * Provenance of the registration, used for collision policy. Skill
   * resolution must never bind a package skill slug to a non-skill tool.
   */
  source: "core" | "spawn" | "skill";
  definition: FunctionTool;
  advertise?: boolean;
  execution:
    | {
        type: "server";
        handler:
          | ToolHandler
          | ToolHandler<CheckpointToolHandlerContext>
          | ToolHandler<SpawnToolHandlerContext>
          | ToolHandler<ReturnResultToolHandlerContext>;
      }
    | { type: "client" };
  timeoutMs?: number;
  sequential?: boolean;
  capability?: "checkpoint" | "spawn" | "return_result";
}

/**
 * The registry port: a name-keyed store of tool registrations.
 *
 * `register` is additive — registering a tool with the same name a second
 * time overwrites the previous registration.
 *
 * `getDefinitions` returns the `FunctionTool[]` array consumed by the
 * gateway as the `tools` field of a model request. Only server-executable
 * tools with `definition.type === "function"` are included (hosted tools are
 * handled separately by the gateway's provider adapters).
 *
 * `getRegistration` is the lookup used by the executor to find a handler
 * and its constraints (`timeoutMs`, `sequential`) at dispatch time.
 */
export interface ToolRegistry {
  register(registration: ToolRegistration): void;
  getDefinitions(): FunctionTool[];
  getRegistration(name: string): ToolRegistration | undefined;
}
