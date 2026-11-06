// biome-ignore-all lint/suspicious/noExplicitAny: Adapter request-map bridges canonical ↔ SDK types; casts are intentional.
/**
 * Anthropic request mapper: converts canonical GenerateRequests into Anthropic
 * Messages request bodies (messages, system, tools, thinking config). Owns the
 * canonical→Anthropic translation.
 *
 * Key decisions:
 * - System messages are extracted into the top-level `system` param because
 *   Anthropic treats system prompts separately from the message array.
 * - Tool-result messages (role="tool") become user messages with tool_result
 *   content blocks — Anthropic requires tool results in a user-turn message.
 * - Reasoning replay: thinking/redacted_thinking blocks (with signature or
 *   data) are only sent back to the same provider/model pair. Redacted thinking
 *   carries opaque provider data for continuity.
 * - Consecutive same-role messages are merged to satisfy Anthropic's
 *   alternating user/assistant requirement. Thinking blocks within assistant
 *   content are ordered first (Anthropic requires thinking before tool_use/text).
 * - Last-step repair: models that think by default (`reasoning.thinksByDefault`) and
 *   are not switched off prepend empty `{ type: "thinking", thinking: "" }` when an
 *   assistant message has tool_use and no thinking block. Missing tool_result
 *   is repaired earlier in context-builder `completeToolResultGroups`.
 * - Reasoning: a resolved effort goes out as `output_config.effort`; `off` (only
 *   resolved for models with a toggle, such as DeepSeek) goes out as
 *   `thinking: {type: "disabled"}`; `default` sends nothing. Opus 5.5, Sonnet 5.5
 *   and Fable 5.1 think adaptively, and `thinking: disabled` or `budget_tokens`
 *   is a 400 on them, which is why they never resolve to `off`.
 * - Prompt caching: when the call resolves to an explicit `cache_control`
 *   (`markCachePrefix`), the mapper marks the last system block and the last
 *   block of the two most recent wire `user` messages — three breakpoints, under
 *   Anthropic's limit of 4. Tools are never marked: Anthropic renders tools before
 *   system before messages, so the system breakpoint covers them. The newest user
 *   mark writes this request's cache entry; the older one is the read point, where
 *   the previous request wrote its own tail, so the prefix is served from cache
 *   (Anthropic's "moving breakpoint" guidance). Anthropic folds tool results into
 *   user turns, so a long assistant/tool loop still leaves the previous tail as
 *   the second-latest user message; its ~20-block lookback tolerates a steer
 *   landing beside a tool result. Marks go on wire user messages, whose last block
 *   always accepts `cache_control`. Marks move as the tail
 *   advances; providers hash content, not the marker, so that never invalidates
 *   a cached prefix. A 1h write costs 2x input tokens (5m: 1.25x) — see the
 *   registry's `cacheWriteUsdPerMillionTokens` pinned rates.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ContentPart,
  GenerateRequest,
  Message,
  ModelInfo,
  ResolvedCall,
  Tool,
} from "../../domain/index.js";
import { safeToolOutput } from "../../helpers/serialize.js";
import { anthropicToolSchema } from "./tool-schema.js";

type CacheControl = Anthropic.Messages.CacheControlEphemeral;

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

/** The `cache_control` each supported lifetime is sent as. */
const CACHE_CONTROL_BY_TTL = new Map<number, CacheControl>([
  [FIVE_MINUTES_MS, { type: "ephemeral", ttl: "5m" }],
  [ONE_HOUR_MS, { type: "ephemeral", ttl: "1h" }],
]);

/** Reject, at gateway creation, a model whose explicit cache lifetimes this API cannot be sent. */
export function assertCacheTtlsOnWire(model: Pick<ModelInfo, "id" | "promptCache">): void {
  const { kind, shortTtlMs, longTtlMs } = model.promptCache;
  if (kind !== "explicit") return;
  for (const ttl of [shortTtlMs, longTtlMs]) {
    if (ttl === null || !CACHE_CONTROL_BY_TTL.has(ttl)) {
      throw new Error(`Explicit prompt cache TTL for ${model.id} must be 5 minutes or 1 hour`);
    }
  }
}

// ── Content part mapping ──────────────────────────────────────────
//
// Canonical ContentPart → Anthropic content blocks.
// Extracts the Anthropic content-block union type from the SDK for type-safe
// block construction. Reasoning parts are only replayed to matching
// provider/model origins; images use url/base64 sources; tool_use/tool_result
// map directly.
//

type AnthropicContentBlock = Anthropic.MessageCreateParams["messages"][number] extends {
  content: infer C;
}
  ? C extends Array<infer B>
    ? B
    : never
  : never;

function matchesReasoningOrigin(
  part: Extract<ContentPart, { type: "reasoning" }>,
  targetProviderId: string,
  targetModelId: string,
): boolean {
  const origin = part.providerOptions?.meridian;
  return origin?.provider === targetProviderId && origin?.model === targetModelId;
}

function mapContentPartToAnthropicBlock(
  part: ContentPart,
  targetProviderId: string,
  targetModelId: string,
): AnthropicContentBlock | null {
  switch (part.type) {
    case "text":
      if (part.text.length === 0) return null;
      return {
        type: "text" as const,
        text: part.text,
      } as any;
    case "image": {
      const data = part.data instanceof URL ? part.data.href : part.data;
      if (data.startsWith("http://") || data.startsWith("https://")) {
        return {
          type: "image" as const,
          source: { type: "url" as const, url: data },
        } as any;
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          data,
          media_type: part.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        },
      } as any;
    }
    case "tool_use":
      return {
        type: "tool_use" as const,
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      } as any;
    case "tool_result":
      return {
        type: "tool_result" as const,
        tool_use_id: part.toolCallId,
        content: safeToolOutput(part.output),
        is_error: part.isError ?? false,
      } as any;
    case "reasoning": {
      if (!matchesReasoningOrigin(part, targetProviderId, targetModelId)) return null;
      const anthropic = part.providerOptions?.anthropic;
      if (anthropic?.redacted === true && typeof anthropic.data === "string") {
        return {
          type: "redacted_thinking" as const,
          data: anthropic.data,
        } as any;
      }
      if (typeof anthropic?.signature === "string" && anthropic.signature.length > 0) {
        return {
          type: "thinking" as const,
          thinking: part.text,
          signature: anthropic.signature,
        } as any;
      }
      return null;
    }
    default:
      // file, custom — best effort: pass as text
      return {
        type: "text" as const,
        text:
          "data" in part && typeof part.data === "string" && part.data.length > 0
            ? part.data
            : JSON.stringify(part),
      } as any;
  }
}

function textFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ── Message mapping ───────────────────────────────────────────────
//
// Canonical Message → Anthropic MessageParam.
// System messages are extracted separately. Tool messages become user messages
// with tool_result blocks. Simple text-only messages use the string shorthand.
// Consecutive same-role messages are merged to satisfy Anthropic's
// alternating-role constraint.
//

/**
 * Order thinking blocks before other content in assistant messages.
 * Anthropic requires thinking/redacted_thinking blocks to precede
 * text and tool_use blocks in the content array.
 */
function orderedAnthropicBlocks(blocks: AnthropicContentBlock[]): AnthropicContentBlock[] {
  const isThinking = (block: AnthropicContentBlock) =>
    block.type === "thinking" || block.type === "redacted_thinking";
  return [...blocks.filter(isThinking), ...blocks.filter((block) => !isThinking(block))];
}

function mapMessage(
  message: Message,
  targetProviderId: string,
  targetModelId: string,
): Anthropic.Messages.MessageParam | null {
  // system messages are extracted separately
  if (message.role === "system") return null;

  const role = message.role === "tool" ? ("user" as const) : (message.role as "user" | "assistant");

  // Tool result messages → user message with tool_result blocks
  if (message.role === "tool") {
    const blocks = message.content
      .filter((p) => p.type === "tool_result")
      .map((p) => mapContentPartToAnthropicBlock(p, targetProviderId, targetModelId))
      .filter((p): p is AnthropicContentBlock => p !== null);
    return blocks.length > 0 ? { role: "user", content: blocks as any } : null;
  }

  // Simple text-only messages can use string shorthand
  const hasOnlyText = message.content.every((p) => p.type === "text");
  if (hasOnlyText && message.content.length > 0) {
    const text = textFromParts(message.content);
    if (text.length === 0) return null;
    return { role, content: text };
  }

  const blocks = message.content
    .map((part) => mapContentPartToAnthropicBlock(part, targetProviderId, targetModelId))
    .filter((p): p is AnthropicContentBlock => p !== null);
  return blocks.length > 0 ? { role, content: orderedAnthropicBlocks(blocks) as any } : null;
}

function messageContentBlocks(
  content: Anthropic.Messages.MessageParam["content"],
): Anthropic.Messages.ContentBlockParam[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/**
 * Merge consecutive messages with the same role into a single message.
 * Anthropic requires strict alternation between user and assistant roles;
 * consecutive messages of the same role must be collapsed. Thinking blocks
 * in the merged assistant content are re-ordered to the front.
 */
const EMPTY_THINKING = { type: "thinking" as const, thinking: "" } as AnthropicContentBlock;

function blockIsThinking(block: Anthropic.Messages.ContentBlockParam): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

/** DeepSeek thinking mode (and Anthropic thinking) require thinking before tool_use. */
function ensureThinkingBeforeToolUse(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const blocks = messageContentBlocks(message.content);
    const hasToolUse = blocks.some((block) => block.type === "tool_use");
    if (!hasToolUse || blocks.some(blockIsThinking)) return message;
    return {
      ...message,
      content: orderedAnthropicBlocks([EMPTY_THINKING, ...blocks]),
    };
  });
}

function mergeConsecutiveSameRole(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  const merged: Anthropic.Messages.MessageParam[] = [];

  for (const message of messages) {
    const previous = merged.at(-1);
    if (!previous || previous.role !== message.role) {
      merged.push(message);
      continue;
    }

    const content = [
      ...messageContentBlocks(previous.content),
      ...messageContentBlocks(message.content),
    ];
    merged[merged.length - 1] = {
      ...previous,
      content:
        previous.role === "assistant" ? (orderedAnthropicBlocks(content as any) as any) : content,
    };
  }

  return merged;
}

// ── System prompt extraction ──────────────────────────────────────
//
// System messages are joined into the top-level `system` string; cache marking
// turns it into a single marked text block (see `markCachePrefix`).
//

function extractSystem(messages: Message[]): string | undefined {
  const system = textFromParts(
    messages.filter((m) => m.role === "system").flatMap((m) => m.content),
  );
  return system.length > 0 ? system : undefined;
}

// ── Cache marking ─────────────────────────────────────────────────

/** Put `cacheControl` on the last block. Wire user messages are never empty and hold no thinking or empty-text block (both are dropped when mapped), so the last block can always carry it. */
function markLastBlock(
  content: Anthropic.Messages.MessageParam["content"],
  cacheControl: CacheControl,
): Anthropic.Messages.ContentBlockParam[] {
  const blocks = messageContentBlocks(content);
  const last = blocks.length - 1;
  blocks[last] = { ...blocks[last], cache_control: cacheControl } as any;
  return blocks;
}

/** Mark the system prompt and the two most recent wire user messages. */
function markCachePrefix(
  system: string | undefined,
  messages: Anthropic.Messages.MessageParam[],
  cacheControl: CacheControl,
): {
  system: string | Anthropic.Messages.TextBlockParam[] | undefined;
  messages: Anthropic.Messages.MessageParam[];
} {
  const marked = [...messages];
  let remaining = 2;
  for (let index = marked.length - 1; index >= 0 && remaining > 0; index--) {
    if (marked[index].role !== "user") continue;
    remaining--;
    marked[index] = {
      ...marked[index],
      content: markLastBlock(marked[index].content, cacheControl),
    };
  }
  return {
    system: system && [{ type: "text", text: system, cache_control: cacheControl }],
    messages: marked,
  };
}

// ── Tool mapping ──────────────────────────────────────────────────
//
// Canonical Tool[] → Anthropic ToolUnion[]. Function tools map to Anthropic
// tools with input_schema. Tools are never cache-marked directly: Anthropic
// renders tools before system before messages, so the system message's own
// breakpoint already covers them (see the file header).
//

function mapTools(
  tools: Tool[] | undefined,
  projectSchema: boolean,
): Anthropic.Messages.ToolUnion[] | undefined {
  if (!tools?.length) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (projectSchema
      ? anthropicToolSchema(tool.inputSchema)
      : tool.inputSchema) as Anthropic.Messages.Tool.InputSchema,
  }));
}

// ── Public: build Anthropic params ────────────────────────────────
//
// Assembles the full MessageCreateParamsStreaming from a canonical
// GenerateRequest. Always sets stream:true.
//

export function toAnthropicMessageParams(
  request: GenerateRequest,
  model: Pick<
    ModelInfo,
    "id" | "provider" | "maxOutputTokens" | "reasoning" | "promptCache" | "projectToolSchema"
  >,
  call: ResolvedCall,
): Anthropic.Messages.MessageCreateParamsStreaming {
  // Only an explicit-cache model gets cache_control: DeepSeek, on this adapter, caches on its own.
  const cacheControl =
    model.promptCache.kind === "explicit" && call.cacheTtlMs !== null
      ? CACHE_CONTROL_BY_TTL.get(call.cacheTtlMs)
      : undefined;
  const tools = mapTools(request.tools, model.projectToolSchema === true);
  const messages = mergeConsecutiveSameRole(
    request.messages
      .map((message) => mapMessage(message, model.provider, model.id))
      .filter((m): m is Anthropic.Messages.MessageParam => m !== null),
  );

  const { reasoning } = call;
  const repaired =
    model.reasoning.thinksByDefault && reasoning !== "off"
      ? ensureThinkingBeforeToolUse(messages)
      : messages;
  const plainSystem = extractSystem(request.messages);
  const { system, messages: wireMessages } = cacheControl
    ? markCachePrefix(plainSystem, repaired, cacheControl)
    : { system: plainSystem, messages: repaired };

  return {
    model: model.id,
    max_tokens: model.maxOutputTokens,
    messages: wireMessages,
    stream: true,
    ...(system !== undefined ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(typeof reasoning === "object" ? { output_config: { effort: reasoning.effort } } : {}),
    ...(reasoning === "off" ? { thinking: { type: "disabled" as const } } : {}),
  };
}
