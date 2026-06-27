/**
 * OpenAI Responses stream accumulator: folds OpenAI streaming events into
 * canonical StreamEvents and a final GenerateResult. The Responses protocol
 * names the same logical output item by different keys in different event
 * families, so this file owns the reconciliation from provider item IDs,
 * call IDs, and output positions into Meridian's canonical ContentPart,
 * ToolCall, Usage, and FinishReason vocabulary.
 *
 * Key decision: provider `output_index` is treated as the source-order spine.
 * Text, reasoning, and tool-use items are accumulated under that stable output
 * position and sorted only when building the final result, so persisted content
 * follows the provider's streamed order instead of being grouped by part type.
 *
 * Provider-protocol grounding (verified against OpenAI SDK 4.104.0 + docs):
 * - `output_index` is the position of the output item in `response.output[]`.
 *   The final array order is model-dependent and the docs do NOT explicitly
 *   guarantee non-interleaving during streaming, so Meridian buffers by index
 *   and sorts at assembly time rather than trusting arrival order.
 * - `response.function_call_arguments.delta` events carry `item_id` and
 *   `output_index` but NOT `call_id` (confirmed in SDK types). This is why
 *   argument deltas are buffered in `pendingDeltas` until the durable `call_id`
 *   arrives via `response.output_item.added` or a later event.
 * - SDK v6 renamed the streaming event literals from `response.reasoning.*`
 *   to `response.reasoning_text.*`; keep the accumulator keyed by output item
 *   identity so the external Meridian contract does not change.
 */

import type { Usage } from "@meridian/contracts/runtime";
import type OpenAI from "openai";
import type {
  ContentPart,
  FinishReason,
  GenerateResult,
  StreamEvent,
  ToolCall,
} from "../../domain/index.js";

// ── Accumulator ───────────────────────────────────────────────────

interface StreamAccumulator {
  // Unindexed fallback content. Most Responses output has `output_index`; text
  // that arrives through auxiliary events such as refusals does not, so it is
  // appended after indexed content rather than being guessed into the order.
  contentParts: ContentPart[];
  // Responses can emit multiple distinct text output items in one assistant
  // turn. Keeping one buffer per `output_index` preserves text blocks that are
  // separated by reasoning/tool-use blocks instead of merging all text together.
  textPartsByOutputIndex: Map<number, string>;
  // Reasoning events may refer to either a stable output item ID (`item_id`) or
  // only the item's position (`output_index`). Both maps point at the same entry
  // so deltas, done events, and completed-output snapshots converge.
  reasoningItems: Map<string, ReasoningItemEntry>;
  reasoningItemsByOutputIndex: Map<number, ReasoningItemEntry>;
  // Function-call events are even more fragmented: argument deltas can arrive
  // with only `item_id`/`output_index`, while later item events reveal `call_id`
  // (the ID Meridian must expose to tools). These three lookups reconcile all
  // provider references to one mutable ToolCallEntry.
  //
  // Rationale for the three-map design: the Responses protocol refers to the
  // same function call by `call_id` (the durable tool identity used in
  // tool_result messages), `item_id` (the provider output-item identity), and
  // `output_index` (the stable position in `response.output[]`). Different
  // event families use different keys: argument deltas arrive with
  // item_id+output_index but no call_id; output_item.added reveals call_id;
  // the completed response output snapshot references items by position. All
  // three maps point at the same mutable ToolCallEntry so updates converge
  // regardless of which key the current event provides.
  toolCalls: Map<string, ToolCallEntry>;
  toolCallsByItemId: Map<string, ToolCallEntry>;
  toolCallsByOutputIndex: Map<number, ToolCallEntry>;
  usage: Usage;
  finishReason: FinishReason;
  model: string;
  provider: string;
}

interface ReasoningItemEntry {
  // Provider output item ID, used for encrypted-reasoning replay back to the
  // same OpenAI model. It may be learned after text deltas have already arrived.
  itemId?: string;
  // Stable provider position for ordering and for deltas that lack a known ID.
  outputIndex: number;
  text: string;
  // OpenAI can return encrypted reasoning content; Meridian preserves it in
  // providerOptions so future requests can replay the reasoning item statelessly.
  encrypted?: string;
}

interface ToolCallEntry {
  // Responses item ID and function-call ID are distinct. The `callId` is the
  // canonical tool_call ID used by later tool_result messages; `itemId` is how
  // some stream events refer to the provider output item before callId is known.
  itemId?: string;
  outputIndex: number;
  callId?: string;
  name: string;
  arguments: string;
  // Argument deltas can precede the event that reveals `call_id` because the
  // SDK's ResponseFunctionCallArgumentsDeltaEvent carries `item_id` and
  // `output_index` but no `call_id` (SDK-confirmed — not a docs guarantee).
  // We keep their raw JSON fragments here so the adapter can emit canonical
  // tool_call.delta events in order once it has a stable ID to attach them to.
  pendingDeltas: string[];
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function createStreamAccumulator(model: string, provider: string): StreamAccumulator {
  return {
    contentParts: [],
    textPartsByOutputIndex: new Map(),
    reasoningItems: new Map(),
    reasoningItemsByOutputIndex: new Map(),
    toolCalls: new Map(),
    toolCallsByItemId: new Map(),
    toolCallsByOutputIndex: new Map(),
    usage: emptyUsage(),
    finishReason: "end_turn",
    model,
    provider,
  };
}

function rememberReasoningItemEntry(acc: StreamAccumulator, entry: ReasoningItemEntry): void {
  // Re-register on every update because an entry can start life keyed only by
  // outputIndex and later gain itemId/encrypted content from a different event.
  if (entry.itemId) acc.reasoningItems.set(entry.itemId, entry);
  acc.reasoningItemsByOutputIndex.set(entry.outputIndex, entry);
}

function findReasoningItemEntry(
  acc: StreamAccumulator,
  params: { itemId?: string; outputIndex: number },
): ReasoningItemEntry | undefined {
  // Prefer the provider item ID when present, but fall back to output_index so
  // early deltas and final snapshots still update the same logical reasoning part.
  return (
    (params.itemId ? acc.reasoningItems.get(params.itemId) : undefined) ??
    acc.reasoningItemsByOutputIndex.get(params.outputIndex)
  );
}

function rememberReasoningOutputItem(
  acc: StreamAccumulator,
  item: OpenAI.Responses.ResponseReasoningItem,
  outputIndex: number,
): void {
  // `response.output_item.*` and the completed response output can carry
  // metadata (notably encrypted_content) without carrying the full accumulated
  // text. Merge metadata into any entry created earlier by reasoning deltas.
  const entry = findReasoningItemEntry(acc, {
    itemId: item.id,
    outputIndex,
  }) ?? {
    outputIndex,
    text: "",
  };
  entry.itemId = item.id;
  entry.outputIndex = outputIndex;
  if (item.encrypted_content) entry.encrypted = item.encrypted_content;
  rememberReasoningItemEntry(acc, entry);
}

function rememberToolCallEntry(acc: StreamAccumulator, entry: ToolCallEntry): void {
  // One ToolCallEntry intentionally lives in three indexes. Responses stream
  // events are not consistent about whether they name a function call by callId,
  // output item ID, or output position.
  if (entry.callId) acc.toolCalls.set(entry.callId, entry);
  if (entry.itemId) acc.toolCallsByItemId.set(entry.itemId, entry);
  acc.toolCallsByOutputIndex.set(entry.outputIndex, entry);
}

function findToolCallEntry(
  acc: StreamAccumulator,
  params: { callId?: string; itemId?: string; outputIndex: number },
): ToolCallEntry | undefined {
  // Lookup order follows semantic strength: callId is Meridian's durable tool
  // identity, itemId is the provider output identity, and output_index is the
  // ordering fallback used by deltas before either ID has appeared.
  return (
    (params.callId ? acc.toolCalls.get(params.callId) : undefined) ??
    (params.itemId ? acc.toolCallsByItemId.get(params.itemId) : undefined) ??
    acc.toolCallsByOutputIndex.get(params.outputIndex)
  );
}

// ── Usage mapping ─────────────────────────────────────────────────

export function mapUsage(usage: OpenAI.Responses.ResponseUsage): Usage {
  // Responses reports canonical input/output token totals directly, but cache
  // hits and reasoning tokens live in provider-specific detail objects
  // (`input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`).
  // Both fields are confirmed in the OpenAI reasoning guide and the installed
  // SDK's ResponseUsage shape. Meridian only sets optional Usage fields when the
  // provider reports a positive value.
  const result: Usage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };

  if (usage.input_tokens_details?.cached_tokens > 0) {
    result.cacheReadTokens = usage.input_tokens_details.cached_tokens;
  }

  if (usage.output_tokens_details?.reasoning_tokens > 0) {
    result.reasoningTokens = usage.output_tokens_details.reasoning_tokens;
  }

  return result;
}

// ── Status → FinishReason mapping ─────────────────────────────────

export function mapResponseStatus(
  status: OpenAI.Responses.ResponseStatus | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): FinishReason {
  // A tool call means the assistant is intentionally handing control back to the
  // orchestrator, even if the response status looks otherwise terminal. Keep
  // that precedence so the loop executes tools instead of treating the turn as
  // a plain assistant answer.
  if (hasToolCalls) return "tool_use";

  // SDK ResponseStatus is 'completed' | 'failed' | 'in_progress' | 'cancelled'
  // | 'queued' | 'incomplete'. Only 'incomplete' and 'failed' need mapping;
  // other terminal statuses default to end_turn below.
  if (status === "incomplete") {
    // Response.IncompleteDetails.reason is 'max_output_tokens' | 'content_filter'
    // (SDK-confirmed). The canonical FinishReason has no content_filter variant,
    // so filtered content → "error"; exhausted tokens → "max_tokens". Unknown
    // incomplete reasons default to max_tokens: the response was cut short
    // rather than naturally ended.
    if (incompleteReason === "max_output_tokens") return "max_tokens";
    if (incompleteReason === "content_filter") return "error";
    return "max_tokens";
  }

  if (status === "failed") return "error";
  if (status === "cancelled") return "error";

  return "end_turn";
}

// ── Stream event processing ───────────────────────────────────────

export function* eventsFromResponseStreamEvent(
  event: OpenAI.Responses.ResponseStreamEvent,
  acc: StreamAccumulator,
): Generator<StreamEvent> {
  // Each yielded StreamEvent is the low-latency canonical view for clients, while
  // the accumulator keeps the lossless state needed for the final GenerateResult.
  switch (event.type) {
    case "response.output_text.delta": {
      // `output_index` identifies the whole output item's position in
      // `response.output[]`, not the text content fragment within an item.
      // Accumulating by index preserves separate text items across a multi-item
      // response and supplies the canonical `partIndex` for deltas. Because the
      // docs do not guarantee non-interleaving of output items during streaming,
      // we buffer per-index and sort only at assembly time.
      acc.textPartsByOutputIndex.set(
        event.output_index,
        (acc.textPartsByOutputIndex.get(event.output_index) ?? "") + event.delta,
      );
      yield {
        type: "text.delta",
        text: event.delta,
        partIndex: event.output_index,
      };
      break;
    }

    case "response.reasoning_text.delta": {
      // OpenAI SDK v6 exposes reasoning text as its own stream family. Keep the
      // object fallback because older recorded/mock events used `{ text }` deltas
      // and the normalization is harmless at this provider boundary.
      const text =
        typeof event.delta === "string"
          ? event.delta
          : typeof event.delta === "object" && event.delta !== null && "text" in event.delta
            ? String((event.delta as { text: unknown }).text)
            : "";
      if (text) {
        // Reasoning deltas carry both `item_id` and `output_index` when the
        // provider knows them. The helper lets this delta merge with metadata
        // learned from output-item events in either order.
        const entry = findReasoningItemEntry(acc, {
          itemId: event.item_id,
          outputIndex: event.output_index,
        }) ?? {
          itemId: event.item_id,
          outputIndex: event.output_index,
          text: "",
        };
        entry.itemId = event.item_id;
        entry.outputIndex = event.output_index;
        entry.text += text;
        rememberReasoningItemEntry(acc, entry);
        yield {
          type: "reasoning.delta",
          text,
          partIndex: event.output_index,
        };
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      // Function-call argument deltas stream as raw JSON text.
      // ResponseFunctionCallArgumentsDeltaEvent (SDK-confirmed) carries
      // `item_id` and `output_index` but NOT `call_id`, so arguments can arrive
      // before `response.output_item.added` has supplied call_id/name.
      // We accumulate immediately but only emit canonical deltas once a durable
      // call_id exists, because downstream tool_result messages must reference
      // the provider call_id exactly.
      let entry = findToolCallEntry(acc, {
        itemId: event.item_id,
        outputIndex: event.output_index,
      });
      if (!entry) {
        entry = {
          itemId: event.item_id,
          outputIndex: event.output_index,
          name: "",
          arguments: "",
          pendingDeltas: [],
        };
        rememberToolCallEntry(acc, entry);
      }
      entry.arguments += event.delta;
      if (entry.callId) {
        // Once callId is known, every subsequent raw JSON fragment can be
        // forwarded as a canonical tool_call.delta tied to the stable tool ID.
        yield {
          type: "tool_call.delta",
          id: entry.callId,
          name: entry.name,
          argumentsDelta: event.delta,
          partIndex: event.output_index,
        };
      } else {
        // Without callId, emitting would create an unusable delta: downstream
        // tool-result messages must reference the provider call_id exactly.
        entry.pendingDeltas.push(event.delta);
      }
      break;
    }

    case "response.output_item.added": {
      const item = event.item;
      if (item.type === "reasoning") {
        // Reasoning item metadata can precede or follow reasoning.delta text.
        rememberReasoningOutputItem(acc, item, event.output_index);
      }
      if (item.type === "function_call") {
        // This event is where Responses usually reveals the call_id and tool
        // name. It may be racing with argument deltas, so merge with any entry
        // created earlier by output_index/item_id instead of replacing it.
        const entry = findToolCallEntry(acc, {
          callId: item.call_id,
          itemId: item.id,
          outputIndex: event.output_index,
        }) ?? {
          outputIndex: event.output_index,
          name: "",
          arguments: "",
          pendingDeltas: [],
        };
        entry.itemId = item.id;
        entry.outputIndex = event.output_index;
        entry.callId = item.call_id;
        entry.name = item.name;
        if (entry.arguments === "" && item.arguments) {
          entry.arguments = item.arguments;
        }
        rememberToolCallEntry(acc, entry);
        // Flush buffered JSON fragments in original arrival order now that the
        // canonical delta can carry the provider call_id.
        for (const argumentsDelta of entry.pendingDeltas.splice(0)) {
          yield {
            type: "tool_call.delta",
            id: item.call_id,
            name: item.name,
            argumentsDelta,
            partIndex: event.output_index,
          };
        }
      }
      break;
    }

    case "response.output_item.done": {
      const item = event.item;
      if (item.type === "reasoning") {
        // Done events can be the last chance to observe reasoning metadata.
        rememberReasoningOutputItem(acc, item, event.output_index);
      }
      if (item.type === "function_call") {
        // The done event can contain the final full arguments string. Prefer it
        // over reconstructed deltas when present, while keeping the same entry
        // and indexes for ordering.
        const entry = findToolCallEntry(acc, {
          callId: item.call_id,
          itemId: item.id,
          outputIndex: event.output_index,
        });
        if (entry) {
          entry.itemId = item.id;
          entry.outputIndex = event.output_index;
          entry.callId = item.call_id;
          entry.name = item.name;
          if (item.arguments) {
            entry.arguments = item.arguments;
          }
          rememberToolCallEntry(acc, entry);
        }
      }
      break;
    }

    case "response.function_call_arguments.done": {
      // The provider sends a final full JSON argument string. Store it so
      // GenerateResult parses the authoritative final payload, even if deltas
      // were missing, duplicated, or chunked oddly.
      const entry = findToolCallEntry(acc, {
        itemId: event.item_id,
        outputIndex: event.output_index,
      });
      if (entry && event.arguments) {
        entry.arguments = event.arguments;
      }
      break;
    }

    case "response.completed": {
      const response = event.response;

      // The completed response carries the provider's terminal status and final
      // usage. Tool-use precedence is handled inside mapResponseStatus.
      acc.finishReason = mapResponseStatus(
        response.status,
        response.incomplete_details?.reason,
        acc.toolCalls.size > 0,
      );

      // Usage appears only on terminal events for Responses streams
      // (response.completed). Emit it as a canonical usage event now so
      // subscribers see token counts before the adapter later emits the final
      // end event with the assembled GenerateResult.
      if (response.usage) {
        acc.usage = mapUsage(response.usage);
        yield { type: "usage", usage: acc.usage };
      }
      response.output.forEach((item, outputIndex) => {
        if (item.type === "reasoning") {
          // The terminal output array is indexed in source order and can include
          // encrypted reasoning content that did not appear on streaming deltas.
          rememberReasoningOutputItem(acc, item, outputIndex);
        }
      });
      break;
    }

    case "response.refusal.delta": {
      // Refusal text is not a normal output_text item and has no output_index in
      // the SDK event (ResponseRefusalDeltaEvent carries item_id/output_index
      // but no content_index for per-part positioning). Preserve it as text in
      // the unindexed fallback so callers still see the provider's refusal
      // explanation, appended after indexed content.
      const refusalEvent = event as { delta?: string };
      if (refusalEvent.delta) {
        acc.contentParts.push({ type: "text", text: refusalEvent.delta });
      }
      break;
    }

    case "response.reasoning_text.done": {
      // Reasoning.done supplies the final full reasoning text for an item. Store
      // it authoritatively, preserving any item metadata already reconciled.
      const entry = findReasoningItemEntry(acc, {
        itemId: event.item_id,
        outputIndex: event.output_index,
      }) ?? {
        itemId: event.item_id,
        outputIndex: event.output_index,
        text: "",
      };
      entry.itemId = event.item_id;
      entry.outputIndex = event.output_index;
      entry.text = event.text;
      rememberReasoningItemEntry(acc, entry);
      break;
    }

    // Lifecycle/content-part boundary events are useful for the provider stream
    // but do not add canonical content beyond deltas/items already handled.
    case "response.created":
    case "response.in_progress":
    case "response.content_part.added":
    case "response.content_part.done":
    case "response.output_text.done":
      break;

    default:
      // Other hosted-tool/provider events (web_search, code_interpreter, etc.)
      // have no Meridian-canonical ContentPart/StreamEvent mapping yet. Ignore
      // rather than inventing a lossy custom contract at this boundary.
      break;
  }
}

// ── Build final result ────────────────────────────────────────────

export function accumulatorHasPartialResult(acc: StreamAccumulator): boolean {
  return (
    acc.usage.inputTokens > 0 ||
    acc.usage.outputTokens > 0 ||
    acc.contentParts.length > 0 ||
    acc.textPartsByOutputIndex.size > 0 ||
    acc.reasoningItemsByOutputIndex.size > 0 ||
    acc.toolCalls.size > 0
  );
}

export function buildGenerateResult(acc: StreamAccumulator): GenerateResult {
  // Build the final assistant content in source order. Each accumulated
  // reasoning/text/tool_use part is tagged with provider `output_index` (the
  // position in `response.output[]`), then sorted once here so persisted block
  // order matches the provider stream rather than being grouped by part type
  // (all reasoning, then all text, then all tools) as a naive Map iteration
  // would produce.
  const indexedParts: Array<{ index: number; part: ContentPart }> = [];

  for (const [index, reasoning] of acc.reasoningItemsByOutputIndex.entries()) {
    // Keep provider metadata with reasoning so future OpenAI requests can replay
    // encrypted reasoning items only to the same provider/model pair.
    if (!reasoning.text && !reasoning.itemId && !reasoning.encrypted) continue;
    indexedParts.push({
      index,
      part: {
        type: "reasoning",
        text: reasoning.text,
        providerOptions: {
          openai: {
            ...(reasoning.itemId ? { itemId: reasoning.itemId } : {}),
            ...(reasoning.encrypted ? { encrypted: reasoning.encrypted } : {}),
          },
          meridian: { provider: acc.provider, model: acc.model },
        },
      },
    });
  }

  for (const [index, text] of acc.textPartsByOutputIndex.entries()) {
    // Text is intentionally stored by output_index instead of one global buffer:
    // a text item between two reasoning/tool items must stay in that position,
    // and distinct text output items must not be merged across rounds.
    if (!text) continue;
    indexedParts.push({ index, part: { type: "text", text } });
  }

  const toolCalls: ToolCall[] = [];
  for (const entry of acc.toolCalls.values()) {
    // Only entries with the provider call_id can participate in the canonical
    // tool-call contract; tool_result messages must reference this exact ID.
    if (!entry.callId) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = entry.arguments ? (JSON.parse(entry.arguments) as Record<string, unknown>) : {};
    } catch {
      // Preserve malformed provider JSON instead of dropping the call. The tool
      // executor receives a structured object with the raw argument text.
      parsed = { raw: entry.arguments };
    }
    indexedParts.push({
      index: entry.outputIndex,
      part: {
        type: "tool_use",
        toolCallId: entry.callId,
        toolName: entry.name,
        input: parsed,
      },
    });
    toolCalls.push({ id: entry.callId, name: entry.name, arguments: parsed });
  }

  const content = indexedParts
    .sort((a, b) => a.index - b.index)
    .map(({ part }) => part)
    // Anything without a provider position, such as refusal text, is appended as
    // an explicit fallback after all source-indexed output.
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
