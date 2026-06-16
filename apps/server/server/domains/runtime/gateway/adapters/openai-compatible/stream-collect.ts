/**
 * OpenAI-compatible stream accumulator: folds Chat Completions streaming chunks
 * into canonical StreamEvents and a final GenerateResult. This adapter targets
 * providers that expose OpenAI's Chat Completions shape rather than the newer
 * Responses item stream, so ordering information is less expressive: text is a
 * choice-level delta stream, while tool calls are keyed by `delta.tool_calls[n].index`.
 *
 * Key decision: preserve the Chat Completions semantics directly. Text is kept
 * in a single assistant text buffer because the protocol does not expose stable
 * content-block positions for separate text parts; tool calls are accumulated by
 * their `tool_calls[].index` (the required fragment-grouping key per the
 * ChatCompletionChunk.Choice.Delta.ToolCall SDK shape) so interleaved argument
 * fragments rebuild the correct ToolCall entries.
 *
 * Provider-protocol grounding (verified against OpenAI SDK 4.104.0):
 * - Chat Completions `finish_reason` on streaming chunks is `'stop' | 'length'
 *   | 'tool_calls' | 'content_filter' | 'function_call' | null` (SDK-confirmed).
 *   `null` means the stream is still in progress; only the final content chunk
 *   carries a non-null finish_reason.
 * - `usage` on streamed chat chunks is only present when
 *   `stream_options: { include_usage: true }` is set. It is null on earlier
 *   chunks; the final chunk may be empty apart from usage. Interrupted or
 *   cancelled streams may never deliver the final usage chunk (docs warning).
 * - `tool_calls[].index` is a required field on Delta.ToolCall (SDK-confirmed)
 *   and is the stable identity for one tool call within the streamed assistant
 *   message. ID, name, and arguments for the same index can be split across
 *   multiple chunks.
 * - There is NO separate reasoning channel in the OpenAI Chat Completions
 *   protocol. Any `reasoning_content` handling (e.g., DeepSeek) is
 *   provider-specific and outside the OpenAI SDK surface — it is accessed via
 *   untyped property access on the delta object.
 */
import type { Usage } from "@meridian/contracts/runtime";
import type {
  ContentPart,
  FinishReason,
  GenerateResult,
  StreamEvent,
  ToolCall,
} from "../../domain/index.js";

interface StreamAccumulator {
  // Final content in the order this Chat Completions adapter can reconstruct.
  // Unlike Responses/Anthropic, the chat stream does not provide a source index
  // for separate text blocks, so text is flushed as one canonical TextPart.
  contentParts: ContentPart[];
  textBuffer: string;
  // Chat Completions streams tool calls as an array of deltas keyed by
  // `tool_calls[].index` — a required field on Delta.ToolCall (SDK-confirmed).
  // The same index receives the id/name and successive argument JSON fragments,
  // sometimes across different chunks.
  toolCalls: Map<number, { id?: string; name: string; arguments: string; pendingDeltas: string[] }>;
  usage: Usage;
  finishReason: FinishReason;
  model: string;
  provider: string;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function createStreamAccumulator(model: string, provider: string): StreamAccumulator {
  return {
    contentParts: [],
    textBuffer: "",
    toolCalls: new Map(),
    usage: emptyUsage(),
    finishReason: "end_turn",
    model,
    provider,
  };
}

export function flushTextBuffer(acc: StreamAccumulator): void {
  // The provider may split one assistant message over many content deltas. Delay
  // creating the canonical TextPart until the end so callers do not persist one
  // block per token/chunk.
  if (acc.textBuffer) {
    acc.contentParts.push({ type: "text", text: acc.textBuffer });
    acc.textBuffer = "";
  }
}

export function accumulatorHasPartialResult(acc: StreamAccumulator): boolean {
  return (
    acc.usage.inputTokens > 0 ||
    acc.usage.outputTokens > 0 ||
    acc.textBuffer.length > 0 ||
    acc.contentParts.length > 0 ||
    acc.toolCalls.size > 0
  );
}

export function buildGenerateResult(acc: StreamAccumulator): GenerateResult {
  // Chat Completions has no final response object with reconstructed content, so
  // the GenerateResult is built entirely from accumulated deltas.
  flushTextBuffer(acc);

  const toolCalls: ToolCall[] = [];
  for (const [index, entry] of acc.toolCalls.entries()) {
    // Some compatible providers omit tool_call.id in early or all chunks. The
    // fallback is deterministic within the response so the canonical contract
    // still has an ID for tool_result references.
    const id = entry.id ?? `call_${index}`;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = entry.arguments ? (JSON.parse(entry.arguments) as Record<string, unknown>) : {};
    } catch {
      // Preserve malformed provider JSON as an explicit raw payload. That keeps
      // the tool_use visible to the orchestrator instead of losing the call.
      parsed = { raw: entry.arguments };
    }
    acc.contentParts.push({
      type: "tool_use",
      toolCallId: id,
      toolName: entry.name,
      input: parsed,
    });
    toolCalls.push({ id, name: entry.name, arguments: parsed });
  }

  return {
    content: [...acc.contentParts],
    toolCalls,
    finishReason: acc.finishReason,
    usage: acc.usage,
    model: acc.model,
    provider: acc.provider,
  };
}

export function applyUsage(acc: StreamAccumulator, usage: Usage): void {
  // Usage is delivered out-of-band on chunks only when stream_options includes
  // `include_usage` (SDK-confirmed: ChatCompletionStreamOptions.include_usage).
  // The SDK docs warn that interrupted/cancelled streams may never deliver the
  // final usage chunk. Replace the accumulator with the provider's latest totals.
  acc.usage = usage;
}

export function mapFinishReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): FinishReason {
  // Chat Completions finish_reason (SDK-confirmed union: 'stop' | 'length' |
  // 'tool_calls' | 'content_filter' | 'function_call' | null). `null` means
  // streaming is in progress; only the final content chunk carries a non-null
  // value. Some compatible providers also emit tool-call deltas without setting
  // finish_reason='tool_calls', so observed tool calls take precedence so the
  // orchestrator always executes tools whenever a call was actually assembled.
  if (hasToolCalls || reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason === "content_filter") return "error";
  return "end_turn";
}

export function* eventsFromOpenAIChunk(
  chunk: {
    id?: string;
    choices?: Array<{
      index?: number;
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
      prompt_tokens_details?: { cached_tokens?: number };
    } | null;
  },
  acc: StreamAccumulator,
): Generator<StreamEvent> {
  // This adapter consumes only the first streamed choice. The gateway API models
  // one assistant continuation per request, and request mapping never asks for
  // multiple choices.
  const choice = chunk.choices?.[0];
  if (!choice) return;

  // DeepSeek thinking models send reasoning via `reasoning_content` — not
  // part of the OpenAI SDK types (ChatCompletionChunk.Choice.Delta has no
  // `reasoning_content` field), so access via untyped cast. Chat Completions
  // does not provide a standard reasoning channel or final reasoning block
  // shape, so this is surfaced as streaming reasoning.delta only. There is no
  // accumulated canonical ReasoningPart for this path.
  const reasoningContent = (choice.delta as Record<string, unknown> | undefined)?.reasoning_content;
  if (typeof reasoningContent === "string" && reasoningContent) {
    yield { type: "reasoning.delta", text: reasoningContent };
  }

  if (choice.delta?.content) {
    // Choice-level text deltas have no per-part index. Accumulate into the
    // response text buffer and emit canonical text.delta without partIndex.
    acc.textBuffer += choice.delta.content;
    yield { type: "text.delta", text: choice.delta.content };
  }

  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      // `index` is the required stable identity for one tool call within the
      // streamed assistant message (Delta.ToolCall.index, SDK-confirmed).
      // ID/name/arguments can be split across chunks for the same index; the
      // provider may omit `id` in early chunks and supply it later.
      const index = tc.index ?? 0;
      let entry = acc.toolCalls.get(index);
      if (!entry) {
        entry = {
          id: tc.id,
          name: tc.function?.name ?? "",
          arguments: "",
          pendingDeltas: [],
        };
        acc.toolCalls.set(index, entry);
      }
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.id) {
        // Once the provider supplies the durable tool-call ID, buffered argument
        // fragments can be emitted as canonical tool_call.delta events tied to
        // that ID. Some compatible providers omit ID in early or all chunks;
        // buildGenerateResult falls back to a deterministic `call_<index>` ID.
        entry.id = tc.id;
        for (const argumentsDelta of entry.pendingDeltas.splice(0)) {
          yield {
            type: "tool_call.delta",
            id: entry.id,
            name: entry.name,
            argumentsDelta,
          };
        }
      }
      if (tc.function?.arguments) {
        // Arguments are streamed as raw JSON fragments. As with Responses, do
        // not emit a canonical delta before an ID is known because downstream
        // tool results need a stable tool_call_id reference.
        entry.arguments += tc.function.arguments;
        if (entry.id) {
          yield {
            type: "tool_call.delta",
            id: entry.id,
            name: entry.name,
            argumentsDelta: tc.function.arguments,
          };
        } else {
          // Keep early fragments in arrival order until the ID arrives.
          entry.pendingDeltas.push(tc.function.arguments);
        }
      }
    }
  }

  if (chunk.usage) {
    // OpenAI-compatible providers deliver cumulative usage on the final chunk
    // (or a trailing usage-only chunk) when stream_options.include_usage is
    // set. Map prompt/completion tokens and optional reasoning tokens into
    // Meridian Usage. The SDK docs warn: interrupted streams may never deliver
    // this chunk.
    const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
    const cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const usage: Usage = {
      inputTokens: chunk.usage.prompt_tokens ?? 0,
      outputTokens: chunk.usage.completion_tokens ?? 0,
      ...(reasoningTokens ? { reasoningTokens } : {}),
      ...(cacheReadTokens ? { cacheReadTokens } : {}),
    };
    applyUsage(acc, usage);
    yield { type: "usage", usage };
  }

  if (choice.finish_reason) {
    // Finish reason can arrive on the last choice delta, after all content/tool
    // chunks. Combine it with observed tool calls for canonical finishReason.
    acc.finishReason = mapFinishReason(choice.finish_reason, acc.toolCalls.size > 0);
  }
}
