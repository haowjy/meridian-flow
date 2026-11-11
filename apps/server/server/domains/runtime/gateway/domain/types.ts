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
 * - `GenerateRequest.promptCacheKey` is canonical prompt-cache *intent*, not
 *   provider syntax, so it stays top-level (never nested in `providerOptions`):
 *   the loop knows the thread's stable key but has no opinion on TTL or wire
 *   shape. Each adapter decides whether to forward it (a `prompt_cache_key`
 *   routing hint, or nothing). Cache breakpoints are not part of the request:
 *   the Anthropic adapter places them on the wire blocks itself.
 */
import type { Usage } from "@meridian/contracts/runtime";
import type { ProviderErrorResponse } from "@meridian/contracts/threads";

export type ProviderOptions = Record<string, Record<string, unknown>>;

/** Tokenizer family used for conservative model-input estimation. */
export type TokenizerFamily = "anthropic" | "o200k" | "gemini" | "deepseek";

/**
 * Declared LLM capability flags, from the model's row in config/registry.ts.
 * Only `image_input` is read today (the context builder keeps images for models
 * that take them); add a value when something branches on it.
 */
export type Capability = "image_input";

/** Provider cache lifetimes are recorded as the provider states them, in seconds. Anything that must beat a lifetime computes its buffer from these values. */
export const DEFAULT_SUBAGENT_PROMPT_CACHE_TTL = 5 * 60;
export const DEFAULT_PRIMARY_PROMPT_CACHE_TTL = 60 * 60;

/** Registry-declared provider cache behavior and its best-known retention window. */
export interface PromptCacheDescriptor {
  kind: "explicit" | "automatic";
  /** Lifetime in seconds of a short-retention request (subagents); null means the provider documents none. */
  shortTtlSeconds: number | null;
  /** Lifetime of a long-retention request (primary chats); equals `shortTtlSeconds` when the provider offers one lifetime. */
  longTtlSeconds: number | null;
}

/**
 * Which cache lifetime a request wants: primary chats ask for long, subagents for short,
 * and a one-shot call nothing reads again (a rolling summary) for none: no cache mark is sent.
 */
export type PromptCacheRetention = "none" | "short" | "long";

/** The TTL a request with this retention gets from a model, for adapters and warm/cold prediction. */
export function resolvePromptCacheTtlSeconds(
  cache: PromptCacheDescriptor,
  retention: PromptCacheRetention,
): number | null {
  if (retention === "none") return null;
  return retention === "long" ? cache.longTtlSeconds : cache.shortTtlSeconds;
}

export const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * A model's reasoning controls, copied from its models.dev `reasoning_options`
 * (`xhigh`, which Flow never requests, is omitted from `efforts`).
 */
export interface ReasoningSupport {
  /** Effort levels the model accepts. */
  efforts: readonly ReasoningEffort[];
  /** Whether reasoning can be turned off: a `toggle` option or a `none` effort. */
  canDisable?: true;
  /**
   * The model reasons unless switched off, so the Anthropic adapter must repair a replayed
   * tool-use turn that lost its thinking block. Declared, not inferred from `canDisable`:
   * a model can have a toggle and still not think by default.
   */
  thinksByDefault?: true;
}

/**
 * Static model metadata registered per provider. `provider` is the id of the
 * ProviderConfig that declares the model.
 */
export interface ModelInfo {
  reasoning: ReasoningSupport;
  /** The serving provider wants Anthropic's tool-schema projection (`anthropicToolSchema`); others get the schema as given. */
  projectToolSchema?: true;
  /** Whole-request input repricing threshold, if the model has one. */
  inputTierTokens?: number;
  /** Underlying tokenizer family. */
  tokenizer: TokenizerFamily;
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  promptCache: PromptCacheDescriptor;
  capabilities: Set<Capability>;
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
  /**
   * Parsed tool-call input. When `inputParseError` is present, this is `{}`
   * because the provider emitted tool-call JSON that could not be parsed or
   * repaired; downstream must surface a model-facing parse error rather than
   * dispatching the tool.
   */
  input: Record<string, unknown>;
  inputParseError?: { raw: string; message: string };
  providerOptions?: ProviderOptions;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: unknown;
  isError?: boolean;
  providerOptions?: ProviderOptions;
}

export type ContentPart =
  | TextPart
  | ImagePart
  | FilePart
  | ReasoningPart
  | ToolUsePart
  | ToolResultPart;

/**
 * A canonical chat message — maps directly to Anthropic Messages and OpenAI
 * Chat/Responses message shapes. The `tool` role carries tool_result parts
 * back to the provider after execution.
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
}

/**
 * A tool Flow executes, with a JSON Schema input signature. The orchestrator
 * sends these to the provider as part of the tool definitions, and the
 * adapter translates them into the provider's tool schema format.
 */
export interface Tool {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The unified request shape that every adapter translates into its provider SDK call.
 *
 * Routing: `resolveRoute` in routing.ts picks the provider that declares the
 * requested model in its config.
 *
 * Cancellation: the `signal` AbortSignal is propagated through the adapter chain
 * and into the provider SDK call. The deadline helper in deadline.ts derives a
 * per-attempt sub-signal from it, so a killed attempt still respects the parent
 * signal for full-request cancellation.
 */
export interface GenerateRequest {
  model?: string;
  messages: Message[];
  tools?: Tool[];
  reasoning?: "disabled" | "adaptive" | { effort: ReasoningEffort };
  signal?: AbortSignal;
  /**
   * Stable per-thread cache-routing key (opaque, not a secret): unlike
   * `correlation` below, adapters MAY map this into the provider request —
   * e.g. OpenAI Responses `prompt_cache_key`, which improves cache-affinity
   * routing for automatic caching. Anthropic has no equivalent concept and
   * ignores it.
   */
  promptCacheKey?: string;
  /** Cache lifetime wanted; fixed per thread kind (`none` for one-shot calls nothing re-reads) so the cached prefix never changes mid-thread. */
  promptCacheRetention: PromptCacheRetention;
  /** Observability-only context; adapters must never map it into provider requests. */
  correlation?: {
    /** Preallocated by callers that need to join request content to lifecycle evidence. */
    gatewayCallId?: string;
    threadId?: string;
    turnId?: string;
    iteration?: number;
    agentSlug?: string;
  };
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
  | "invalid_request"
  | "content_filtered"
  | "context_overflow"
  | "provider_error";

export type { ProviderErrorResponse } from "@meridian/contracts/threads";

/**
 * Stream event — the canonical event set that every adapter emits and the
 * orchestrator consumes. Each event is a complete, Meridian-typed value; the
 * generator produces them one-at-a-time so subscribers receive them as they
 * arrive from the provider without waiting for the full response.
 *
 * Ordering contract:
 * - "start" is always first (emitted once per provider call).
 * - Content deltas (text/reasoning/tool_call) are emitted in provider
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
  | { type: "usage"; usage: Usage }
  | { type: "end"; result: GenerateResult }
  | {
      type: "error";
      code: ErrorCode;
      /** Metered partial output when the provider terminates with an error. */
      result?: GenerateResult;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
      /** Present when the provider answered; absent for network, timeout, and local failures. */
      providerError?: ProviderErrorResponse;
    };

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
  /**
   * Parsed tool-call arguments. When `argumentsParseError` is present, this is
   * `{}` because the provider emitted tool-call JSON that could not be parsed
   * or repaired.
   */
  arguments: Record<string, unknown>;
  argumentsParseError?: { raw: string; message: string };
}

/**
 * Why the provider stopped generating.
 *
 * Provider mapping:
 * - Anthropic StopReason → FinishReason: `end_turn`→`end_turn`, `tool_use`→`tool_use`,
 *   `max_tokens`→`max_tokens`, `stop_sequence`→`stop_sequence`, `refusal`→`error`.
 *   NOTE: Anthropic docs additionally list `model_context_window_exceeded` but the
 *   installed SDK 0.100.1 union does not include it; if that value arrives at runtime
 *   the adapter maps the wire string to the canonical `context_overflow` error.
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
 */
export interface GenerateResult {
  content: ContentPart[];
  toolCalls: ToolCall[];
  /** Null when the call was stopped: the adapter's finish reason then says nothing true. */
  finishReason: FinishReason | null;
  usage: Usage;
  model: string;
  provider: string;
  /** Set on a cancelled stream that reported no usage: the call is unmetered, not free. */
  meteringStatus?: "missing_usage";
  /** Populated by the per-attempt gateway loop on a successful terminal event. */
  timing?: ModelCallTiming;
}

/** Provider-arrival timing for one successful model request attempt. */
export interface ModelCallTiming {
  /** Wall-clock start of this attempt, retained even under consumer backpressure. */
  requestStartedAt: string;
  /** Adapter invocation to stream-end arrival; null if the pump was already backpressured. */
  latencyMs: number | null;
  /** Adapter invocation to first output; null if absent or the pump was already backpressured. */
  timeToFirstTokenMs: number | null;
  /** First output to stream-end arrival; null if absent or any consumer backpressure occurred. */
  generationMs: number | null;
}

/** The provider adapters createAdapter (create-gateway.ts) can build. */
export type BuiltinAdapter = "anthropic" | "openai" | "openai-compatible";

/**
 * A configured provider entry. `adapter` selects the provider adapter factory
 * in createAdapter (create-gateway.ts). `baseUrl` overrides the provider's
 * default API endpoint.
 */
export interface ProviderConfig {
  id: string;
  adapter: BuiltinAdapter;
  auth?: {
    apiKey?: string;
    headers?: Record<string, string>;
  };
  baseUrl?: string;
  models: ModelInfo[];
}

/**
 * Gateway configuration — the single input to createGateway().
 *
 * Policy knobs:
 * - `attemptStallMs`: inactivity (stall) timeout for one provider attempt
 *   (default `DEFAULT_ATTEMPT_STALL_MS`). Enforced by the deadline helper, which aborts the in-flight
 *   provider stream when no progress arrives within the window. Every stream
 *   event re-arms it, so a slow-but-streaming model is never killed. 0 disables.
 * - `attemptCeilingMs`: absolute backstop for one provider attempt (default
 *   `DEFAULT_ATTEMPT_CEILING_MS`), fixed from attempt start. Not the normal terminator; 0 disables it
 *   for self-hosted models. Timeouts are retryable.
 * - `retry`: controls per-provider retry with exponential backoff. Only
 *   retries before committed output (visible text or a tool call) has been
 *   emitted to the caller; reasoning-only attempts are retryable.
 */
export interface GatewayConfig {
  providers: ProviderConfig[];
  defaultModel?: string;
  /** Inactivity window for one provider attempt; re-armed on every event. 0 disables. */
  attemptStallMs?: number;
  /** Absolute ceiling for one provider attempt. 0 disables. Retry/backoff is outside this window. */
  attemptCeilingMs?: number;
  retry?: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
  /** Registry build warnings (e.g. duplicate model IDs skipped). */
  onWarning?: (span: TraceSpan) => void;
}

/** Minimal trace span passed to `GatewayConfig.onWarning`. */
export interface TraceSpan {
  name: string;
  attributes?: Record<string, unknown>;
}
