/**
 * OpenAI-compatible request mapper: converts canonical GenerateRequests into
 * Chat Completions request bodies (messages, tools, response_format). Owns the
 * canonical→chat-completions translation.
 *
 * Key decisions:
 * - Tool-result messages (role="tool") use the Chat Completions `tool` role
 *   with `tool_call_id` referencing the original call.
 * - Assistant messages with tool_use parts emit both a text `content` field
 *   (possibly null) and a `tool_calls` array, matching the Chat Completions
 *   assistant-message shape.
 * - Image parts trigger array-format content (text + image_url blocks);
 *   text-only messages use the simpler string content format.
 * - `stream_options: { include_usage: true }` is always set so the final
 *   chunk carries cumulative token usage (per OpenAI streaming docs).
 * - Prompt caching (OpenRouter's Anthropic-family models only — capability-
 *   gated in the model registry, so a plain OpenAI-Chat-Compatible endpoint
 *   never sees any of this): the loop's canonical `ContentPart.cacheBreakpoint`
 *   is only honored on the *system* message, as an explicit per-part
 *   `cache_control` (OpenRouter's own wire shape, identical to Anthropic's).
 *   Whenever the system message carries a mark, this mapper also sets a
 *   top-level, request-wide `cache_control` — OpenRouter's "automatic
 *   caching" toggle, which places a breakpoint on the last cacheable block
 *   for us. That one field does the job of the read-point/tail marks the
 *   loop also leaves on other messages (deliberately unread here — see
 *   `mapMessage`), so the rest of the conversation never needs an explicit
 *   per-part mark. Both use the owner-chosen 1h ttl.
 */
import type OpenAI from "openai";

import type {
  ContentPart,
  FunctionTool,
  GenerateRequest,
  Message,
  Tool,
} from "../../domain/index.js";
import { safeToolOutput } from "../../helpers/serialize.js";

function textFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Owner-chosen default: 1h everywhere OpenRouter makes cache TTL configurable. */
const CACHE_CONTROL_1H = { type: "ephemeral" as const, ttl: "1h" as const };

/** OpenRouter's per-part `cache_control` passthrough uses Anthropic's own block shape. */
type CacheControllableTextPart = OpenAI.Chat.Completions.ChatCompletionContentPartText & {
  cache_control?: typeof CACHE_CONTROL_1H;
};

/**
 * OpenRouter-only request-level field: "automatic caching" (breakpoint on the
 * last cacheable block), documented for Anthropic/Vertex/Azure/Bedrock
 * providers. Not part of the OpenAI SDK's own ChatCompletionCreateParams type.
 */
type ChatCompletionCreateParamsWithCache = OpenAI.Chat.Completions.ChatCompletionCreateParams & {
  cache_control?: typeof CACHE_CONTROL_1H;
};

/**
 * Map canonical ContentPart[] to Chat Completions content.
 * Text-only messages use the string shorthand; messages with images use the
 * array format (text + image_url blocks). Non-text/non-image parts are
 * silently dropped because Chat Completions has no native reasoning_part or
 * tool_use_part in user/assistant message content. Cache-agnostic: only the
 * dedicated system-message mapping below ever emits `cache_control`.
 */
function mapContentParts(
  parts: ContentPart[],
): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  const hasImage = parts.some((p) => p.type === "image");
  if (!hasImage) return textFromParts(parts);

  const mapped: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text.length > 0) {
          mapped.push({ type: "text", text: part.text });
        }
        break;
      case "image": {
        const url =
          part.data instanceof URL
            ? part.data.href
            : part.data.startsWith("data:")
              ? part.data
              : `data:${part.mediaType};base64,${part.data}`;
        mapped.push({ type: "image_url", image_url: { url } });
        break;
      }
      default:
        break;
    }
  }
  return mapped;
}

/**
 * Map the canonical system message. This is the one place the loop's
 * `cacheBreakpoint` mark is honored per-part (see the file header): each
 * marked text part gets an explicit `cache_control`.
 */
function mapSystemMessage(
  message: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam | null {
  const textParts = message.content.filter(
    (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text" && p.text.length > 0,
  );
  if (textParts.length === 0) return null;
  if (!textParts.some((p) => p.cacheBreakpoint)) {
    return { role: "system", content: textFromParts(textParts) };
  }
  const content: CacheControllableTextPart[] = textParts.map((p) => ({
    type: "text",
    text: p.text,
    ...(p.cacheBreakpoint ? { cache_control: CACHE_CONTROL_1H } : {}),
  }));
  return { role: "system", content };
}

function hasContent(
  content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] | null,
): boolean {
  if (content === null) return false;
  if (typeof content === "string") return content.length > 0;
  return content.length > 0;
}

/**
 * Map a canonical Message to a Chat Completions message param.
 *
 * Role mapping: tool → Chat Completions `tool` role with tool_call_id;
 * assistant with tool_use parts → assistant with tool_calls array;
 * other roles pass through directly. Messages with empty content are
 * filtered out (null return).
 */
function mapMessage(message: Message): OpenAI.Chat.Completions.ChatCompletionMessageParam | null {
  if (message.role === "system") return mapSystemMessage(message);

  if (message.role === "tool") {
    const result = message.content.find((p) => p.type === "tool_result");
    if (!result) return null;
    // Never cache-marked here even if the loop marked this message's tail:
    // the top-level automatic `cache_control` (see toOpenAIChatCompletionParams)
    // already extends the cache over the rest of the conversation.
    return {
      role: "tool",
      tool_call_id: result.toolCallId,
      content: safeToolOutput(result.output),
    };
  }

  if (message.role === "assistant") {
    const toolUses = message.content.filter((p) => p.type === "tool_use");
    if (toolUses.length > 0) {
      return {
        role: "assistant",
        content: textFromParts(message.content) || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.toolCallId,
          type: "function" as const,
          function: {
            name: tu.toolName,
            arguments: JSON.stringify(tu.input),
          },
        })),
      };
    }
  }

  const content = mapContentParts(message.content);
  if (!hasContent(content)) return null;

  return {
    role: message.role,
    content,
  } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
}

/**
 * Map canonical Tool[] to Chat Completions tools.
 * Only function tools are mapped (hosted tools have no Chat Completions
 * equivalent). Each function tool becomes a `function` tool with name,
 * description, and parameters (inputSchema).
 */
function mapTools(
  tools: Tool[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  const functionTools = tools.filter((t): t is FunctionTool => t.type === "function");
  if (!functionTools.length) return undefined;
  return functionTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Map canonical toolChoice to Chat Completions tool_choice.
 * `auto`/`none`/`required` map directly; named tools become
 * `{ type: "function", function: { name } }`.
 */
function mapToolChoice(
  toolChoice: GenerateRequest["toolChoice"],
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  return { type: "function", function: { name: toolChoice.tool } };
}

/**
 * Map canonical responseFormat to Chat Completions response_format.
 * json → json_object; json_schema → json_schema with name/schema/strict;
 * `text` type means no format constraint (undefined).
 */
function mapResponseFormat(
  format: GenerateRequest["responseFormat"],
): OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"] | undefined {
  if (!format || format.type === "text") return undefined;
  if (format.type === "json") {
    return { type: "json_object" };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: format.name ?? "response",
      schema: format.schema,
      strict: format.strict,
    },
  };
}

/** True when the loop marked the system message for prompt caching (registry capability-gated). */
function systemHasCacheBreakpoint(messages: Message[]): boolean {
  return messages.some(
    (m) => m.role === "system" && m.content.some((p) => p.type === "text" && p.cacheBreakpoint),
  );
}

/**
 * Assemble the full ChatCompletionCreateParams from a canonical
 * GenerateRequest. Always sets stream:true and stream_options with
 * include_usage:true (per OpenAI streaming docs) so the final chunk
 * carries cumulative token counts.
 */
export function toOpenAIChatCompletionParams(
  request: GenerateRequest,
  modelId: string,
): ChatCompletionCreateParamsWithCache {
  return {
    model: modelId,
    messages: request.messages
      .map(mapMessage)
      .filter((m): m is OpenAI.Chat.Completions.ChatCompletionMessageParam => m !== null),
    tools: mapTools(request.tools),
    tool_choice: mapToolChoice(request.toolChoice),
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    top_p: request.topP,
    stop: request.stopSequences,
    response_format: mapResponseFormat(request.responseFormat),
    stream: true,
    stream_options: { include_usage: true },
    ...(systemHasCacheBreakpoint(request.messages) ? { cache_control: CACHE_CONTROL_1H } : {}),
  };
}
