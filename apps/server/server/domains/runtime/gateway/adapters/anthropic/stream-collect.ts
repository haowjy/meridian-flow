// biome-ignore-all lint/suspicious/noExplicitAny: Stream accumulator bridges canonical ↔ SDK types; casts are intentional.
/**
 * Anthropic stream accumulator: folds Anthropic Messages streaming events into
 * canonical StreamEvents and a final GenerateResult. The Messages stream is
 * organized around content blocks: `content_block_start` declares a block at a
 * stable `index`, `content_block_delta` streams that block's text/thinking/tool
 * input, and `content_block_stop` closes it.
 *
 * Key decision: the provider content-block `index` is the source-order spine.
 * Text, reasoning, and tool-use parts are accumulated per block index and sorted
 * when building the final result, so persisted content follows the order Claude
 * streamed instead of grouping all reasoning, then all text, then all tools.
 *
 * Provider-protocol grounding (verified against Anthropic SDK 0.100.1 + docs):
 * - Anthropic's documented stream flow is strictly serial per block:
 *   `message_start` → (content_block_start → delta(s) → content_block_stop)*
 *   → `message_delta` → `message_stop`. Each block's `index` corresponds to
 *   its position in the final `Message.content[]` array. The documented flow
 *   implies non-interleaving, though the docs do not state it as a separate
 *   guarantee.
 * - Delta variants consumed: `text_delta` (visible text), `thinking_delta`
 *   (extended-thinking text), `signature_delta` (thinking integrity metadata,
 *   not user-visible, arrives just before `content_block_stop`),
 *   `input_json_delta` (partial JSON for tool input — must be concatenated
 *   before parsing).
 * - StopReason mismatch: current Anthropic docs list
 *   `model_context_window_exceeded`, but the installed SDK 0.100.1's
 *   `StopReason` union is `'end_turn' | 'max_tokens' | 'stop_sequence' |
 *   'tool_use' | 'pause_turn' | 'refusal'` — that value is not present.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { assertValidUsage, type Usage } from "@meridian/contracts/runtime";
import type {
  ContentPart,
  FinishReason,
  GenerateResult,
  StreamEvent,
  ToolCall,
} from "../../domain/index.js";
import { parseToolCallArguments } from "../../helpers/parse-tool-arguments.js";

// ── Accumulator ───────────────────────────────────────────────────

interface StreamAccumulator {
  // Unindexed fallback content. Anthropic's normal assistant output is block-
  // indexed; this exists for any future provider event that must be preserved
  // but cannot be placed in source order.
  contentParts: ContentPart[];
  // One text buffer per Anthropic content block. This prevents two separate
  // text blocks, possibly split by thinking or tool_use blocks, from being
  // merged into a single canonical TextPart. Block index = position in final
  // Message.content[].
  textBlocks: Map<number, string>;
  // Thinking and redacted_thinking blocks are reasoning parts in Meridian. The
  // block index is enough to reconcile start metadata, streaming deltas, and
  // signature deltas for the same block.
  reasoningBlocks: Map<number, ReasoningBlockEntry>;
  // Anthropic tool input streams as JSON fragments on a tool_use content block,
  // so block index is the natural key for ID/name plus accumulated arguments.
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  usage: Usage;
  finishReason: FinishReason;
  model: string;
  provider: string;
}

interface ReasoningBlockEntry {
  text: string;
  // Claude signs thinking blocks that may be replayed in later requests. The
  // signature is provider-specific and must stay in providerOptions, not in
  // the canonical ReasoningPart surface.
  //
  // Signature deltas arrive just before content_block_stop (docs-confirmed)
  // and verify the thinking block's integrity. They are metadata, not
  // user-visible text.
  signature?: string;
  // Redacted thinking has no visible text but carries opaque provider data that
  // can be sent back to Anthropic for continuity.
  redacted?: true;
  data?: string;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function createStreamAccumulator(model: string, provider: string): StreamAccumulator {
  return {
    contentParts: [],
    textBlocks: new Map(),
    reasoningBlocks: new Map(),
    toolCalls: new Map(),
    usage: emptyUsage(),
    finishReason: "end_turn",
    model,
    provider,
  };
}

// ── Finish reason mapping ─────────────────────────────────────────

/**
 * Map Anthropic stop reasons to Meridian FinishReason.
 *
 * The installed SDK 0.100.1 StopReason union is:
 *   'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'
 * Current Anthropic docs additionally list `model_context_window_exceeded`,
 * but that value is NOT in the SDK union — treat it as docs-only.
 */
export function mapStopReason(
  reason: Anthropic.Messages.StopReason | null | undefined,
): FinishReason {
  // Anthropic stop reasons mostly line up with Meridian FinishReason. `refusal`
  // and `pause_turn` have no canonical equivalent today, so they are
  // represented as an error finish and end_turn respectively.
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "error";
    default:
      return "end_turn";
  }
}

// ── Usage mapping ─────────────────────────────────────────────────

export function mapUsage(
  usage: Anthropic.Messages.Usage | Anthropic.Messages.MessageDeltaUsage,
  fallback?: Usage,
): Usage {
  // Anthropic's input_tokens excludes cache reads and cache creation. Meridian's
  // canonical inputTokens is inclusive, so the adapter owns the additive
  // conversion before usage reaches persistence, displays, or pricing.
  const fallbackCacheRead = fallback?.cacheReadTokens ?? 0;
  const fallbackCacheWrite = fallback?.cacheWriteTokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? fallbackCacheRead;
  const cacheWrite = usage.cache_creation_input_tokens ?? fallbackCacheWrite;
  const uncachedInput =
    usage.input_tokens ?? (fallback?.inputTokens ?? 0) - fallbackCacheRead - fallbackCacheWrite;
  const result: Usage = {
    inputTokens: uncachedInput + cacheRead + cacheWrite,
    outputTokens: usage.output_tokens ?? fallback?.outputTokens ?? 0,
  };

  if (cacheRead > 0) result.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) result.cacheWriteTokens = cacheWrite;

  // Anthropic calls reasoning "thinking"; expose it as canonical
  // Usage.reasoningTokens without leaking the provider term downstream.
  // `output_tokens_details.thinking_tokens` is present in the installed SDK
  // but not explicitly documented in the Anthropic docs pages reviewed —
  // treat as SDK-confirmed, docs-unverified.
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? fallback?.reasoningTokens;
  if (thinkingTokens && thinkingTokens > 0) {
    result.reasoningTokens = thinkingTokens;
  }

  assertValidUsage(result);
  return result;
}

// ── Stream event processing ───────────────────────────────────────

export function* eventsFromAnthropicStreamEvent(
  event: Anthropic.Messages.RawMessageStreamEvent,
  acc: StreamAccumulator,
): Generator<StreamEvent> {
  // The generator emits canonical deltas for low-latency subscribers and keeps
  // block-indexed state for the final source-ordered GenerateResult.
  switch (event.type) {
    case "message_start": {
      // message_start carries early usage (usually input-side counts from the
      // initial request processing). Keep it so usage is available even before
      // the terminal message_delta arrives with final token totals.
      if (event.message.usage) {
        acc.usage = mapUsage(event.message.usage);
      }
      break;
    }

    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "thinking") {
        // A thinking block may include initial text and/or a signature at start;
        // later thinking_delta/signature_delta events update this same index.
        // The signature_delta arrives just before content_block_stop (per
        // Anthropic streaming docs) and verifies block integrity.
        acc.reasoningBlocks.set(event.index, {
          text: block.thinking ?? "",
          signature: block.signature || undefined,
        });
      }
      if (block.type === "redacted_thinking") {
        // Redacted thinking is opaque by design. Per Anthropic streaming docs,
        // when thinking is omitted the block opens, receives a single
        // signature_delta, and closes. Preserve provider data for replay, but
        // emit no reasoning.delta because there is no visible text.
        acc.reasoningBlocks.set(event.index, {
          text: "",
          redacted: true,
          data: block.data,
        });
      }
      if (block.type === "tool_use") {
        // Tool-use ID and name are known at block start; only the JSON input
        // streams later through input_json_delta fragments.
        acc.toolCalls.set(event.index, {
          id: block.id,
          name: block.name,
          arguments: "",
        });
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta;

      if (delta.type === "text_delta") {
        // Deltas carry the content-block index. Use it both for canonical
        // partIndex and for reconstructing the final TextPart at that position.
        acc.textBlocks.set(event.index, (acc.textBlocks.get(event.index) ?? "") + delta.text);
        yield {
          type: "text.delta",
          text: delta.text,
          partIndex: event.index,
        };
      }

      if (delta.type === "thinking_delta") {
        // Thinking deltas are provider-visible reasoning text. Accumulate at the
        // block index and surface as canonical reasoning.delta.
        const entry = acc.reasoningBlocks.get(event.index) ?? { text: "" };
        entry.text += delta.thinking;
        acc.reasoningBlocks.set(event.index, entry);
        yield {
          type: "reasoning.delta",
          text: delta.thinking,
          partIndex: event.index,
        };
      }

      if (delta.type === "signature_delta") {
        // Signature deltas are metadata, not user-visible text. They must be
        // retained on the reasoning block so the final ReasoningPart can be
        // replayed to Anthropic when provider/model origin matches. Per
        // Anthropic docs, signature_delta arrives just before
        // content_block_stop for the same block.
        const entry = acc.reasoningBlocks.get(event.index) ?? { text: "" };
        entry.signature = delta.signature;
        acc.reasoningBlocks.set(event.index, entry);
      }

      if (delta.type === "input_json_delta") {
        // Tool input streams as raw partial JSON (delta.partial_json).
        // The final GenerateResult concatenates and parses the joined string
        // into ToolCall.arguments/tool_use.input. Per Anthropic streaming docs,
        // input_json_delta is the protocol for streaming tool input.
        const toolEntry = acc.toolCalls.get(event.index);
        if (toolEntry) {
          toolEntry.arguments += delta.partial_json;
          yield {
            type: "tool_call.delta",
            id: toolEntry.id,
            name: toolEntry.name,
            argumentsDelta: delta.partial_json,
            partIndex: event.index,
          };
        }
      }
      break;
    }

    case "content_block_stop": {
      // Anthropic block_stop is a delimiter only. Content and metadata have
      // already been accumulated through start/delta events.
      break;
    }

    case "message_delta": {
      // message_delta carries terminal stop_reason and final cumulative usage.
      // Per Anthropic docs, stop_reason is null in message_start, supplied in
      // message_delta, and not provided in other events. The content blocks
      // themselves have already been streamed by this point.
      if (event.delta.stop_reason) {
        acc.finishReason = mapStopReason(event.delta.stop_reason);
      }

      // Update usage with delta (has final token counts).
      if (event.usage) {
        acc.usage = mapUsage(event.usage, acc.usage);

        yield { type: "usage", usage: acc.usage };
      }
      break;
    }

    case "message_stop": {
      // Build final result later in the adapter. message_stop is just the stream
      // terminator; emitting canonical end here would duplicate adapter logic.
      break;
    }
  }
}

// ── Build final result ────────────────────────────────────────────

export function accumulatorHasPartialResult(acc: StreamAccumulator): boolean {
  return (
    acc.usage.inputTokens > 0 ||
    acc.usage.outputTokens > 0 ||
    acc.contentParts.length > 0 ||
    acc.textBlocks.size > 0 ||
    acc.reasoningBlocks.size > 0 ||
    acc.toolCalls.size > 0
  );
}

export function buildGenerateResult(acc: StreamAccumulator): GenerateResult {
  // Assemble content by provider block index. This is the ordering fix: without
  // this source-order collection, final content would naturally group by map
  // iteration order (all reasoning before all text before all tools).
  //
  // The block `index` = position in final `Message.content[]` (Anthropic
  // docs-confirmed), so sorting by index reconstructs Claude's intended order.
  const indexedParts: Array<{ index: number; part: ContentPart }> = [];

  for (const [index, reasoning] of acc.reasoningBlocks.entries()) {
    // Plain thinking becomes a simple canonical ReasoningPart. Signed/redacted
    // thinking carries Anthropic metadata plus origin information for replay.
    if (!reasoning.redacted && !reasoning.signature) {
      indexedParts.push({ index, part: { type: "reasoning", text: reasoning.text } });
      continue;
    }
    indexedParts.push({
      index,
      part: {
        type: "reasoning",
        text: reasoning.text,
        providerOptions: {
          anthropic: reasoning.redacted
            ? { redacted: true, data: reasoning.data ?? "" }
            : { signature: reasoning.signature },
          meridian: { provider: acc.provider, model: acc.model },
        },
      },
    });
  }

  for (const [index, text] of acc.textBlocks.entries()) {
    // Text stays per content-block index so a text block between two reasoning
    // blocks keeps its source position and distinct text blocks do not collapse.
    if (!text) continue;
    indexedParts.push({ index, part: { type: "text", text } });
  }

  const toolCalls: ToolCall[] = [];
  for (const [index, entry] of acc.toolCalls.entries()) {
    const parsed = parseToolCallArguments(entry.arguments);
    const input = parsed.ok ? parsed.arguments : {};
    const parseError = parsed.ok ? undefined : { raw: parsed.raw, message: parsed.message };
    indexedParts.push({
      index,
      part: {
        type: "tool_use",
        toolCallId: entry.id,
        toolName: entry.name,
        input,
        ...(parseError ? { inputParseError: parseError } : {}),
      },
    });
    toolCalls.push({
      id: entry.id,
      name: entry.name,
      arguments: input,
      ...(parseError ? { argumentsParseError: parseError } : {}),
    });
  }

  const content = indexedParts
    .sort((a, b) => a.index - b.index)
    .map(({ part }) => part)
    // Future/unindexed fallback content is appended after the provider-indexed
    // blocks because there is no reliable block position to sort by.
    .concat(acc.contentParts);

  return {
    content,
    toolCalls,
    finishReason: acc.finishReason,
    usage: acc.usage,
    model: acc.model,
    provider: acc.provider,
  };
}
