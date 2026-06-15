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
 * - Thinking budget is computed as a percentage of max_tokens, scaled by the
 *   effort level (low=25%, medium=50%, high=75%, max=100%).
 */
import type Anthropic from "@anthropic-ai/sdk";

import type {
  ContentPart,
  FunctionTool,
  GenerateRequest,
  Message,
  Tool,
} from "../../domain/index.js";
import { safeToolOutput } from "../../helpers/serialize.js";

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
        ...(part.providerOptions?.anthropic?.cacheControl
          ? {
              cache_control: part.providerOptions.anthropic
                .cacheControl as Anthropic.Messages.CacheControlEphemeral,
            }
          : {}),
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
    // Check for cache control on any part
    const hasCacheControl = message.content.some(
      (p) => "providerOptions" in p && p.providerOptions?.anthropic?.cacheControl,
    );
    if (!hasCacheControl) {
      return { role, content: text };
    }
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
): string | Anthropic.Messages.TextBlockParam[] | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;

  const systemParts = systemMessages.flatMap((m) => m.content);
  const hasCacheControl = systemParts.some(
    (p) => "providerOptions" in p && p.providerOptions?.anthropic?.cacheControl,
  );

  if (!hasCacheControl) {
    const system = textFromParts(systemParts);
    return system.length > 0 ? system : undefined;
  }

  const systemBlocks = systemParts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .filter((p) => p.text.length > 0)
    .map((p) => {
      const cacheControl = p.providerOptions?.anthropic?.cacheControl;
      return {
        type: "text" as const,
        text: p.text,
        ...(cacheControl
          ? { cache_control: cacheControl as Anthropic.Messages.CacheControlEphemeral }
          : {}),
      };
    });

  return systemBlocks.length > 0 ? systemBlocks : undefined;
}

// ── Tool mapping ──────────────────────────────────────────────────
//
// Canonical Tool[] → Anthropic ToolUnion[]. Function tools map to Anthropic
// tools with input_schema; hosted tools map to web_search_20250305 or
// code_execution_20250522. Cache_control from providerOptions is forwarded.
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
        ...(ft.providerOptions?.anthropic?.cacheControl
          ? {
              cache_control: ft.providerOptions.anthropic
                .cacheControl as Anthropic.Messages.CacheControlEphemeral,
            }
          : {}),
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

// ── Thinking / reasoning config ───────────────────────────────────
//
// Canonical reasoning → Anthropic thinking config.
// Budget is computed as a percentage of max_tokens (low=25%, medium=50%,
// high=75%, max=100%) with floor values to ensure useful thinking space.
// `adaptive` uses medium budget.
//

function mapThinking(
  reasoning: GenerateRequest["reasoning"],
  maxTokens: number,
): Anthropic.Messages.ThinkingConfigParam | undefined {
  if (!reasoning || reasoning === "disabled") return undefined;

  // Budget tokens for thinking — give a generous allocation
  const budgetMap: Record<string, number> = {
    low: Math.max(1024, Math.floor(maxTokens * 0.25)),
    medium: Math.max(2048, Math.floor(maxTokens * 0.5)),
    high: Math.max(4096, Math.floor(maxTokens * 0.75)),
    max: maxTokens,
  };

  if (reasoning === "adaptive") {
    return { type: "enabled", budget_tokens: Math.max(2048, Math.floor(maxTokens * 0.5)) };
  }

  const effort = typeof reasoning === "object" ? reasoning.effort : "medium";
  const budget = budgetMap[effort] ?? Math.max(2048, Math.floor(maxTokens * 0.5));
  return { type: "enabled", budget_tokens: budget };
}

// ── Public: build Anthropic params ────────────────────────────────
//
// Assembles the full MessageCreateParamsStreaming from a canonical
// GenerateRequest. Always sets stream:true. Passes through any extra
// providerOptions.anthropic keys (excluding cacheControl which is handled
// per-part).
//

export function toAnthropicMessageParams(
  request: GenerateRequest,
  modelId: string,
  maxOutputTokens: number,
  providerId = "anthropic",
): Anthropic.Messages.MessageCreateParamsStreaming {
  const maxTokens = request.maxTokens ?? maxOutputTokens;
  const system = extractSystem(request.messages);
  const messages = mergeConsecutiveSameRole(
    request.messages
      .map((message) => mapMessage(message, providerId, modelId))
      .filter((m): m is Anthropic.Messages.MessageParam => m !== null),
  );

  const thinking = mapThinking(request.reasoning, maxTokens);

  return {
    model: modelId,
    max_tokens: maxTokens,
    messages,
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
    ...(request.providerOptions?.anthropic
      ? Object.fromEntries(
          Object.entries(request.providerOptions.anthropic).filter(
            ([k]) => !["cacheControl"].includes(k),
          ),
        )
      : {}),
  };
}
