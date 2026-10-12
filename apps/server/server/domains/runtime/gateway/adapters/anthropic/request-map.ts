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
 * - Last-step repair: thinking-mode requests (and DeepSeek, which is always in
 *   thinking mode) prepend empty `{ type: "thinking", thinking: "" }` when an
 *   assistant message has tool_use and no thinking block. Missing tool_result
 *   is repaired earlier in context-builder `completeToolResultGroups`.
 * - Thinking budget is computed as a percentage of max_tokens, scaled by the
 *   effort level (low=25%, medium=50%, high=75%, max=100%).
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
  FunctionTool,
  GenerateRequest,
  Message,
  Tool,
} from "../../domain/index.js";
import { thinkingBudgetTokens } from "../../domain/thinking-budget.js";
import { safeToolOutput } from "../../helpers/serialize.js";

type CacheControl = Anthropic.Messages.CacheControlEphemeral;

function cacheControlForTtl(ttlMs: number | null | undefined): CacheControl | undefined {
  switch (ttlMs) {
    case 5 * 60 * 1_000:
      return { type: "ephemeral", ttl: "5m" };
    case 60 * 60 * 1_000:
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
// tools with input_schema; hosted tools map to web_search_20250305 or
// code_execution_20250522. Tools are never cache-marked directly: Anthropic
// renders tools before system before messages, so the system message's own
// breakpoint already covers them (see the file header).
//

function mapTools(tools: Tool[] | undefined): Anthropic.Messages.ToolUnion[] | undefined {
  if (!tools?.length) return undefined;

  const mapped: Anthropic.Messages.ToolUnion[] = [];
  for (const tool of tools) {
    if (tool.type === "function") {
      const ft = tool as FunctionTool;
      mapped.push({
        name: ft.name,
        description: ft.description,
        input_schema: ft.inputSchema as Anthropic.Messages.Tool.InputSchema,
      });
    } else if (tool.type === "hosted") {
      if (tool.kind === "web_search" || tool.kind.startsWith("anthropic.web_search")) {
        mapped.push({ type: "web_search_20250305" as any, name: "web_search" } as any);
      }
      if (tool.kind === "code_execution" || tool.kind.startsWith("anthropic.code_execution")) {
        mapped.push({ type: "code_execution_20250522" as any, name: "code_execution" } as any);
      }
      // Other hosted tools: pass through providerOptions
    }
  }
  return mapped.length > 0 ? mapped : undefined;
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
  modelId: string,
  maxOutputTokens: number,
  providerId = "anthropic",
  promptCacheTtlMs?: number | null,
): Anthropic.Messages.MessageCreateParamsStreaming {
  const cacheControl = cacheControlForTtl(promptCacheTtlMs);
  const maxTokens = request.maxTokens ?? maxOutputTokens;
  const system = extractSystem(request.messages, cacheControl);
  const messages = mergeConsecutiveSameRole(
    request.messages
      .map((message) => mapMessage(message, providerId, modelId, cacheControl))
      .filter((m): m is Anthropic.Messages.MessageParam => m !== null),
  );

  // Effort is model-relative: capping output must not change the cached thinking prefix.
  const budget = thinkingBudgetTokens(request, maxOutputTokens);
  const thinking = budget ? { type: "enabled" as const, budget_tokens: budget } : undefined;
  const repaired =
    thinking || providerId === "deepseek" ? ensureThinkingBeforeToolUse(messages) : messages;

  return {
    model: modelId,
    max_tokens: maxTokens,
    messages: repaired,
    stream: true,
    ...(system !== undefined ? { system } : {}),
    ...(mapTools(request.tools) ? { tools: mapTools(request.tools) } : {}),
    ...(mapToolChoice(request.toolChoice)
      ? { tool_choice: mapToolChoice(request.toolChoice) }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
    ...(thinking ? { thinking } : {}),
    ...(request.providerOptions?.anthropic ?? {}),
  };
}
