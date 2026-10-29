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
 * - Last-step repair: models that think by default (`reasoning.canDisable`) and
 *   are not switched off prepend empty `{ type: "thinking", thinking: "" }` when an
 *   assistant message has tool_use and no thinking block. Missing tool_result
 *   is repaired earlier in context-builder `completeToolResultGroups`.
 * - Reasoning: a resolved effort goes out as `output_config.effort`; `off` (only
 *   resolved for models with a toggle, such as DeepSeek) goes out as
 *   `thinking: {type: "disabled"}`; `default` sends nothing. Opus 5.5, Sonnet 5.5
 *   and Fable 5.1 think adaptively, and `thinking: disabled` or `budget_tokens`
 *   is a 400 on them, which is why they never resolve to `off`.
 * - Prompt caching: a canonical `ContentPart.cacheBreakpoint` (set by
 *   `loop/prompt-cache-marks.ts`, at most three per request) becomes an
 *   explicit `cache_control` on that part. Its TTL comes from the registry
 *   descriptor; a 1h write costs 2x input tokens (vs 1.25x for 5m) — see the
 *   registry's `cacheWriteUsdPerMillionTokens` pinned rates. Tools are
 *   never marked directly: Anthropic renders tools before system before
 *   messages, so the system-message breakpoint already covers them.
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

/** Reject, at construction, a model whose explicit cache lifetimes this API cannot be sent. */
export function assertCacheTtlsOnWire(model: Pick<ModelInfo, "id" | "promptCache">): void {
  const { kind, ttlMs, longTtlMs } = model.promptCache;
  if (kind !== "explicit") return;
  for (const ttl of [ttlMs, longTtlMs ?? FIVE_MINUTES_MS]) {
    if (ttl !== FIVE_MINUTES_MS && ttl !== ONE_HOUR_MS) {
      throw new Error(`Explicit prompt cache TTL for ${model.id} must be 5 minutes or 1 hour`);
    }
  }
}

function cacheControlForTtl(ttlMs: number | null | undefined): CacheControl | undefined {
  switch (ttlMs) {
    case FIVE_MINUTES_MS:
      return { type: "ephemeral", ttl: "5m" };
    case ONE_HOUR_MS:
      return { type: "ephemeral", ttl: "1h" };
    default:
      return undefined;
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
  cacheControl: CacheControl | undefined,
): AnthropicContentBlock | null {
  if (part.cacheBreakpoint && !cacheControl) {
    throw new Error("Prompt cache breakpoint requires a supported registry TTL");
  }
  switch (part.type) {
    case "text":
      if (part.text.length === 0) return null;
      return {
        type: "text" as const,
        text: part.text,
        ...(part.cacheBreakpoint && cacheControl ? { cache_control: cacheControl } : {}),
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
        ...(part.cacheBreakpoint && cacheControl ? { cache_control: cacheControl } : {}),
      } as any;
    case "tool_result":
      return {
        type: "tool_result" as const,
        tool_use_id: part.toolCallId,
        content: safeToolOutput(part.output),
        is_error: part.isError ?? false,
        ...(part.cacheBreakpoint && cacheControl ? { cache_control: cacheControl } : {}),
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
// with tool_result blocks. Simple text-only messages use the string shorthand
// unless cache_control is present. Consecutive same-role messages are merged
// to satisfy Anthropic's alternating-role constraint.
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
  cacheControl: CacheControl | undefined,
): Anthropic.Messages.MessageParam | null {
  // system messages are extracted separately
  if (message.role === "system") return null;

  const role = message.role === "tool" ? ("user" as const) : (message.role as "user" | "assistant");

  // Tool result messages → user message with tool_result blocks
  if (message.role === "tool") {
    const blocks = message.content
      .filter((p) => p.type === "tool_result")
      .map((p) => mapContentPartToAnthropicBlock(p, targetProviderId, targetModelId, cacheControl))
      .filter((p): p is AnthropicContentBlock => p !== null);
    return blocks.length > 0 ? { role: "user", content: blocks as any } : null;
  }

  // Simple text-only messages can use string shorthand
  const hasOnlyText = message.content.every((p) => p.type === "text");
  if (hasOnlyText && message.content.length > 0) {
    const text = textFromParts(message.content);
    if (text.length === 0) return null;
    const hasCacheBreakpoint = message.content.some((p) => p.cacheBreakpoint);
    if (!hasCacheBreakpoint) {
      return { role, content: text };
    }
  }

  const blocks = message.content
    .map((part) =>
      mapContentPartToAnthropicBlock(part, targetProviderId, targetModelId, cacheControl),
    )
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
// Extract system messages from the canonical request.
// Without cache_control, system prompts are joined into a single string.
// With cache_control on any system text part, system is emitted as an array
// of text blocks with individual cache_control markers.
//

function extractSystem(
  messages: Message[],
  cacheControl: CacheControl | undefined,
): string | Anthropic.Messages.TextBlockParam[] | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;

  const systemParts = systemMessages.flatMap((m) => m.content);
  const hasCacheBreakpoint = systemParts.some((p) => p.cacheBreakpoint);

  if (!hasCacheBreakpoint) {
    const system = textFromParts(systemParts);
    return system.length > 0 ? system : undefined;
  }
  if (!cacheControl) throw new Error("Prompt cache breakpoint requires a supported registry TTL");

  const systemBlocks = systemParts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .filter((p) => p.text.length > 0)
    .map((p) => ({
      type: "text" as const,
      text: p.text,
      ...(p.cacheBreakpoint ? { cache_control: cacheControl } : {}),
    }));

  return systemBlocks.length > 0 ? systemBlocks : undefined;
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
  providerId: string,
): Anthropic.Messages.ToolUnion[] | undefined {
  if (!tools?.length) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (providerId === "anthropic"
      ? anthropicToolSchema(tool.inputSchema)
      : tool.inputSchema) as Anthropic.Messages.Tool.InputSchema,
  }));
}

// ── Tool choice mapping ───────────────────────────────────────────
//
// Canonical toolChoice → Anthropic tool_choice.
// `auto` → { type: "auto" }, `required` → { type: "any" } (Anthropic's
// equivalent), `none` → omit tools entirely (Anthropic has no explicit
// "none" tool_choice).
//

function mapToolChoice(
  toolChoice: GenerateRequest["toolChoice"],
): Anthropic.Messages.ToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return undefined; // Anthropic: omit tools instead
  if (typeof toolChoice === "object" && "tool" in toolChoice) {
    return { type: "tool", name: toolChoice.tool };
  }
  return undefined;
}

// ── Public: build Anthropic params ────────────────────────────────
//
// Assembles the full MessageCreateParamsStreaming from a canonical
// GenerateRequest. Always sets stream:true. Passes through any extra
// providerOptions.anthropic keys verbatim; prompt-cache marks are canonical
// `ContentPart.cacheBreakpoint`, not a providerOptions key, so nothing needs
// excluding here.
//

export function toAnthropicMessageParams(
  request: GenerateRequest,
  model: Pick<ModelInfo, "id" | "maxOutputTokens" | "reasoning">,
  call: ResolvedCall,
  providerId = "anthropic",
): Anthropic.Messages.MessageCreateParamsStreaming {
  const cacheControl = cacheControlForTtl(call.cacheTtlMs);
  const maxTokens = request.maxTokens ?? model.maxOutputTokens;
  const system = extractSystem(request.messages, cacheControl);
  const tools = mapTools(request.tools, providerId);
  const messages = mergeConsecutiveSameRole(
    request.messages
      .map((message) => mapMessage(message, providerId, model.id, cacheControl))
      .filter((m): m is Anthropic.Messages.MessageParam => m !== null),
  );

  const { reasoning } = call;
  const repaired =
    model.reasoning.canDisable && reasoning !== "off"
      ? ensureThinkingBeforeToolUse(messages)
      : messages;

  return {
    model: model.id,
    max_tokens: maxTokens,
    messages: repaired,
    stream: true,
    ...(system !== undefined ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(mapToolChoice(request.toolChoice)
      ? { tool_choice: mapToolChoice(request.toolChoice) }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
    ...(typeof reasoning === "object" ? { output_config: { effort: reasoning.effort } } : {}),
    ...(reasoning === "off" ? { thinking: { type: "disabled" as const } } : {}),
    ...(request.providerOptions?.anthropic ?? {}),
  };
}
