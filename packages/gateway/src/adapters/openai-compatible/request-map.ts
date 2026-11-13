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
 * - Media parts trigger array-format content (text + image_url/file blocks);
 *   text-only messages use the simpler string content format.
 * - A tool result's media go in one user message right after the run of tool
 *   messages (the `tool` role takes text only), each preceded by a line naming its
 *   tool call, not stringified into the result.
 * - `stream_options: { include_usage: true }` is always set so the final
 *   chunk carries cumulative token usage (per OpenAI streaming docs).
 * - Reasoning: a resolved effort goes out as `reasoning_effort`; `default` and
 *   `off` send nothing (the model's default applies).
 * - No prompt-cache marks are sent: the models on this adapter cache automatically.
 */
import type OpenAI from "openai";

import {
  type ContentPart,
  type GenerateRequest,
  type MediaPart,
  type Message,
  type ModelInfo,
  type ResolvedCall,
  type TextPart,
  type Tool,
  wireMediaSource,
} from "../../domain/index.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type MediaTarget = Pick<ModelInfo, "wire" | "imageLinks">;

function textFromParts(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Images go by link (where the host fetches them) or as a data URL; a PDF is bytes only (`file` with a filename), as Chat Completions has no file URL. */
function mapMedia(part: MediaPart, target: MediaTarget): ChatContentPart {
  const media = wireMediaSource(target, part);
  if (media.kind === "image") {
    const url = "url" in media ? media.url : `data:${media.mediaType};base64,${media.data}`;
    return { type: "image_url", image_url: { url } };
  }
  if ("url" in media) throw new Error("Chat Completions has no file URL for a PDF");
  return {
    type: "file",
    file: { filename: media.filename, file_data: `data:${media.mediaType};base64,${media.data}` },
  };
}

/**
 * Map canonical ContentPart[] to Chat Completions content.
 * Text-only messages use the string shorthand; messages with media use the
 * array format. Non-text/non-media parts are silently dropped because Chat
 * Completions has no native reasoning_part or tool_use_part in user/assistant
 * message content.
 */
function mapContentParts(parts: ContentPart[], target: MediaTarget): string | ChatContentPart[] {
  if (!parts.some((p) => p.type === "media")) return textFromParts(parts);

  const mapped: ChatContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text.length > 0)
      mapped.push({ type: "text", text: part.text });
    else if (part.type === "media") mapped.push(mapMedia(part, target));
  }
  return mapped;
}

function mapSystemMessage(
  message: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam | null {
  const text = textFromParts(message.content.filter((p) => p.type === "text" && p.text.length > 0));
  return text ? { role: "system", content: text } : null;
}

function hasContent(
  content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] | null,
): boolean {
  if (content === null) return false;
  if (typeof content === "string") return content.length > 0;
  return content.length > 0;
}

function mapToolMessage(message: Message): ChatMessage | null {
  const result = message.content.find((p) => p.type === "tool_result");
  if (!result) return null;
  const text = textFromParts(result.content);
  const hasMedia = result.content.some((p) => p.type === "media");
  return {
    role: "tool",
    tool_call_id: result.toolCallId,
    content: text.length > 0 || !hasMedia ? text : "(attachments follow)",
  };
}

/** The user message that carries a run of tool messages' media, or null when they had none. */
function toolMediaMessage(run: Message[], target: MediaTarget): ChatMessage | null {
  const content: ChatContentPart[] = [];
  for (const message of run) {
    const result = message.content.find((p) => p.type === "tool_result");
    const media = result?.content.filter((p) => p.type === "media") ?? [];
    if (!result || media.length === 0) continue;
    content.push({
      type: "text",
      text: `Attachments from the result of tool call ${result.toolCallId}:`,
    });
    for (const part of media) content.push(mapMedia(part, target));
  }
  return content.length > 0 ? { role: "user", content } : null;
}

/** Map a message list; a run of tool messages is followed by one user message with their media. */
function mapMessages(messages: Message[], target: MediaTarget): ChatMessage[] {
  const mapped: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") {
      const next = mapMessage(messages[i], target);
      if (next) mapped.push(next);
      continue;
    }
    const run: Message[] = [];
    while (i < messages.length && messages[i].role === "tool") run.push(messages[i++]);
    i--;
    for (const message of run) {
      const next = mapToolMessage(message);
      if (next) mapped.push(next);
    }
    const media = toolMediaMessage(run, target);
    if (media) mapped.push(media);
  }
  return mapped;
}

/**
 * Map a canonical Message to a Chat Completions message param.
 *
 * Role mapping: tool → Chat Completions `tool` role with tool_call_id;
 * assistant with tool_use parts → assistant with tool_calls array;
 * other roles pass through directly. Messages with empty content are
 * filtered out (null return).
 */
function mapMessage(message: Message, target: MediaTarget): ChatMessage | null {
  if (message.role === "system") return mapSystemMessage(message);
  if (message.role === "tool") return mapToolMessage(message);

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

  const content = mapContentParts(message.content, target);
  if (!hasContent(content)) return null;

  return {
    role: message.role,
    content,
  } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
}

/**
 * Map canonical Tool[] to Chat Completions tools.
 * Each function tool becomes a `function` tool with name,
 * description, and parameters (inputSchema).
 */
function mapTools(
  tools: Tool[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** The SDK type predates `max`; models whose row allows it accept it. */
function mapReasoningEffort(
  reasoning: ResolvedCall["reasoning"],
): OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"] {
  return typeof reasoning === "object" ? (reasoning.effort as "high") : undefined;
}

/**
 * Assemble the full ChatCompletionCreateParams from a canonical
 * GenerateRequest. Always sets stream:true and stream_options with
 * include_usage:true (per OpenAI streaming docs) so the final chunk
 * carries cumulative token counts.
 */
export function toOpenAIChatCompletionParams(
  request: GenerateRequest,
  model: Pick<ModelInfo, "id" | "wire" | "imageLinks">,
  call: ResolvedCall,
): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  return {
    model: model.id,
    messages: mapMessages(request.messages, model),
    tools: mapTools(request.tools),
    reasoning_effort: mapReasoningEffort(call.reasoning),
    stream: true,
    stream_options: { include_usage: true },
  };
}
