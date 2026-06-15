/**
 * Meridian-canonical gateway types (v1 public API): the provider-neutral request,
 * result, stream-event, message, tool, and capability shapes. The vocabulary
 * every adapter maps its provider SDK to and from; depends on nothing provider-specific.
 *
 * Why this boundary exists (see repo AGENTS.md): provider-specific types must
 * stay inside adapter directories so the orchestrator, loop, and tool executors
 * never import `openai` or `@anthropic-ai/sdk`. Every adapter translates to/from
 * these types at the adapter boundary.
 *
 * Key design invariants:
 * - JSON-natural: every field must survive `JSON.parse(JSON.stringify(x))`.
 *   No `Date`, `BigInt`, brand types, or instance objects.
 * - Provider-specific metadata goes in `providerOptions`, never in top-level fields.
 * - `partIndex` on stream deltas is the provider's content-block/output-item position
 *   index (Anthropic block `index`, OpenAI Responses `output_index`, OpenAI-Chat
 *   `tool_calls[].index`), used by adapters to reconstruct source order.
 */
import type { Usage } from "@meridian/contracts/runtime";

export type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Declared LLM capability flags. Used by the orchestrator and context builder
 * to decide whether to include images, enable tool calling, etc. Each adapter
 * reports capabilities from its static model catalog in config/providers.ts.
 */
export type Capability =
  | "streaming"
  | "tool_calling"
  | "parallel_tool_calls"
  | "image_input"
  | "image_output"
  | "file_input"
  | "structured_output"
  | "reasoning"
  | "caching";

/**
 * Static model metadata registered per provider. `provider` is filled in by
 * buildProviderRegistry from the ProviderConfig.id, not from the model's own
 * definition. `hostedTools` lists server-side tools (web_search, code_execution,
 * etc.) that the provider executes without Meridian involvement.
 */
export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: Set<Capability>;
  hostedTools?: Set<string>;
}

/**
 * Canonical content part — the building block of every gateway Message.
 *
 * Each variant corresponds to one provider concept:
 * - TextPart: Anthropic `text` block, OpenAI Responses `output_text` item,
 *   OpenAI-Chat `delta.content`.
 * - ImagePart: Anthropic `image` block, OpenAI `image_url` content part.
 * - FilePart: provider file attachments (pdf, docx, etc.).
 * - ReasoningPart: Anthropic `thinking` / OpenAI `reasoning` items.
 *   Provider metadata (signature, encrypted_content) lives in providerOptions.
 * - ToolUsePart: Anthropic `tool_use` / OpenAI `function_call` items.
 *   `toolCallId` is the provider call identifier used by tool_result to correlate.
 * - ToolResultPart: the output of a tool execution. `isError` flags tool failures
 *   so the provider knows to retry or report the error.
 * - CustomPart: escape hatch for provider-specific content kinds
 *   (e.g., hosted-tool web_search results) that have no canonical representation.
 */

export interface TextPart {
  type: "text";
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ImagePart {
  type: "image";
  data: string | URL;
  mediaType: string;
  providerOptions?: ProviderOptions;
}

export interface FilePart {
  type: "file";
  data: string | URL;
  mediaType: string;
  filename?: string;
  providerOptions?: ProviderOptions;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ToolUsePart {
  type: "tool_use";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}

export interface CustomPart {
  type: "custom";
  kind: `${string}.${string}`;
  data?: unknown;
  providerOptions?: ProviderOptions;
}

export type ContentPart =
  | TextPart
  | ImagePart
  | FilePart
  | ReasoningPart
  | ToolUsePart
  | ToolResultPart
  | CustomPart;

/**
 * A canonical chat message — maps directly to Anthropic Messages and OpenAI
 * Chat/Responses message shapes. The `tool` role carries tool_result parts
 * back to the provider after execution.
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  providerOptions?: ProviderOptions;
}

/**
 * A user-defined tool with a JSON Schema input signature. The orchestrator
 * sends these to the provider as part of the tool definitions, and the
 * adapter translates them into the provider's tool schema format.
 */
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  providerOptions?: ProviderOptions;
}

/**
 * Hosted (server-side) tools executed by the provider itself. Meridian does not
 * execute these — Anthropic's `web_search`, `code_execution`, `text_editor`,
 * `computer_use` and OpenAI's `web_search`, `code_interpreter`, `file_search`.
 */
export type HostedToolKind = "web_search" | "code_execution" | "file_search";

export interface HostedTool {
  type: "hosted";
  kind: HostedToolKind | string;
  providerOptions?: ProviderOptions;
}

export type Tool = FunctionTool | HostedTool;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json" }
  | {
      type: "json_schema";
      schema: Record<string, unknown>;
      name?: string;
      strict?: boolean;
    };

export type ToolChoice = "auto" | "required" | "none" | { tool: string };

/**
 * The unified request shape that every adapter translates into its provider SDK call.
 *
 * Routing: the `provider` field is optional — if omitted, `resolveRoute` in
 * routing.ts picks the provider that declares the requested model in its config.
 * Only set this explicitly when you need to force a specific provider.
 *
 * Cancellation: the `signal` AbortSignal is propagated through the adapter chain
 * and into the provider SDK call. The deadline helper in deadline.ts derives a
 * per-attempt sub-signal from it, so a killed attempt still respects the parent
 * signal for full-request cancellation.
 */
export interface GenerateRequest {
  model?: string;
  provider?: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  responseFormat?: ResponseFormat;
  reasoning?: "disabled" | "adaptive" | { effort: "low" | "medium" | "high" | "max" };
  providerOptions?: ProviderOptions;
  signal?: AbortSignal;
}

/**
 * Canonical error codes surfaced in StreamEvent.error and GatewayError.
 *
 * `provider_error` is the catch-all for unknown/unclassified provider failures,
 * including timeouts (deadline.ts surfaces timeout as a retryable provider_error).
 * `invalid_request` covers missing models, bad config, and upstream aborts.
 */
export type ErrorCode =
  | "network_error"
  | "rate_limited"
  | "server_error"
  | "auth_error"
  | "malformed_response"
  | "invalid_request"
  | "content_filtered"
  | "context_overflow"
  | "provider_error";

/**
 * Stream event — the canonical event set that every adapter emits and the
 * orchestrator consumes. Each event is a complete, Meridian-typed value; the
 * generator produces them one-at-a-time so subscribers receive them as they
 * arrive from the provider without waiting for the full response.
 *
 * Ordering contract:
 * - "start" is always first (emitted once per provider call).
 * - Content deltas (text/reasoning/tool_call/custom) are emitted in provider
 *   arrival order. `partIndex` is the provider content-block position: the
 *   Anthropic block `index`, OpenAI Responses `output_index`, or
 *   OpenAI-Chat-Compatible `tool_calls[].index`. It is set ONLY when the
 *   provider exposes a stable source-order position; the openai-compatible
 *   text deltas omit it because Chat Completions do not partition text into
 *   separate content blocks.
 * - "usage" may appear zero, one, or multiple times depending on provider
 *   convention (e.g., Anthropic sends early usage at message_start + final at
 *   message_delta; OpenAI Responses only at response.completed).
 * - "end" is always last on success; "error" terminates the stream on failure.
 */
export type StreamEvent =
  | { type: "start"; model: string; provider: string }
  | { type: "text.delta"; text: string; partIndex?: number }
  | { type: "reasoning.delta"; text: string; partIndex?: number }
  | {
      type: "tool_call.delta";
      id: string;
      name: string;
      argumentsDelta: string;
      partIndex?: number;
    }
  | { type: "custom.delta"; kind: string; data: unknown; partIndex?: number }
  | { type: "usage"; usage: Usage }
  | { type: "end"; result: GenerateResult }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };

/**
 * A parsed tool call extracted from a provider response. `id` is the provider-
 * specific call identifier (Anthropic `tool_use.id`, OpenAI Responses `call_id`,
 * OpenAI-Chat `tool_calls[].id` or a synthesized `call_${index}` fallback).
 * This ID is the stable key used by `tool_result` messages to correlate
 * outputs back to the call.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Why the provider stopped generating.
 *
 * Provider mapping:
 * - Anthropic StopReason → FinishReason: `end_turn`→`end_turn`, `tool_use`→`tool_use`,
 *   `max_tokens`→`max_tokens`, `stop_sequence`→`stop_sequence`, `refusal`→`error`.
 *   NOTE: Anthropic docs additionally list `model_context_window_exceeded` but the
 *   installed SDK 0.100.1 union does not include it; if that value arrives at runtime
 *   it falls through the switch in stream-collect.ts and becomes `end_turn`.
 * - OpenAI Responses status: `completed`→`end_turn`, `failed`/`cancelled`→`error`,
 *   `incomplete` maps to `max_tokens` or `error` depending on `incomplete_details.reason`.
 * - OpenAI-Chat finish_reason: `stop`→`end_turn`, `tool_calls`→`tool_use`,
 *   `length`→`max_tokens`, `content_filter`→`error`.
 *
 * Precedence: `tool_use` wins over any terminal status when tool calls were
 * actually assembled (the orchestrator must execute tools before considering
 * the turn finished).
 */
export type FinishReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";

/**
 * The final, complete result of one provider call. Built by the adapter's
 * stream accumulator after all stream events have been processed.
 *
 * `content` is ordered in provider source order (Anthropic block index,
 * OpenAI Responses output_index), not grouped by part type. This preserves the
 * model's intended content sequence: reasoning → text → tool_use interleaving.
 *
 * `toolCalls` is a flat list of every parsed ToolCall in the response; the
 * orchestrator uses this to dispatch tool execution.
 *
 * `providerData` is a raw fallback for provider-specific metadata that doesn't
 * fit any canonical field; adapters should prefer providerOptions on individual
 * ContentParts when the metadata is per-part.
 */
export interface GenerateResult {
  content: ContentPart[];
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  model: string;
  provider: string;
  providerData?: unknown;
}

/**
 * Known adapter identifiers. String literals for the built-in adapters plus
 * a catch-all for custom adapter strings. `openrouter` is reserved but not yet
 * implemented — createAdapter throws if you try to construct it.
 */
export type BuiltinAdapter = "anthropic" | "openai" | "openai-compatible" | "openrouter";

/**
 * A configured provider entry. `adapter` selects the provider adapter factory
 * in createAdapter (create-gateway.ts). `baseUrl` overrides the provider's
 * default API endpoint; `transport` picks SSE vs WebSocket when both are
 * available (future).
 */
export interface ProviderConfig {
  id: string;
  adapter: BuiltinAdapter | string;
  auth?: {
    apiKey?: string | (() => string);
    headers?: Record<string, string>;
  };
  baseUrl?: string;
  models: ModelInfo[];
  compliance?: {
    hipaaEligible?: boolean;
    baaActive?: boolean;
    regions?: string[];
  };
  transport?: "auto" | "sse" | "websocket";
}

/**
 * Gateway configuration — the single input to createGateway().
 *
 * Policy knobs:
 * - `attemptTimeoutMs`: per-call wall-clock timeout (default 120s). Enforced
 *   by the deadline helper, which derives an AbortSignal that aborts the
 *   in-flight provider stream. Timeouts are retryable.
 * - `retry`: controls per-provider retry with exponential backoff. Only
 *   retries before any output has been emitted to the caller.
 * - `fallback`: when enabled, tries providers in order; fails over on
 *   retryable errors (including timeouts) before output.
 * - `onTrace`/`onError`: observability hooks; called per provider attempt.
 */
export interface GatewayConfig {
  providers: ProviderConfig[];
  defaultModel?: string;
  /** Wall-clock deadline for one provider attempt. Retry/backoff is outside this window. */
  attemptTimeoutMs?: number;
  retry?: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
  fallback?: { enabled: boolean; order?: string[] };
  /** Registry build warnings (e.g. duplicate model IDs skipped). */
  onWarning?: (span: TraceSpan) => void;
  onTrace?: (span: TraceSpan) => void;
  onError?: (error: GatewayError) => void;
}

/**
 * Minimal trace span stub — observability hooks deferred beyond v1 spine.
 * The GatewayConfig.onTrace callback receives one of these per provider call.
 */
export interface TraceSpan {
  name: string;
  attributes?: Record<string, unknown>;
}

/**
 * Structured error surfaced through the Gateway error callbacks and the
 * `error` StreamEvent. `retryable` controls whether the retry/fallback logic
 * in create-gateway.ts will retry or try the next fallback provider.
 */
export interface GatewayError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
}
