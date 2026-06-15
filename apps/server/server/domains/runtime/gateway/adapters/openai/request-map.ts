// biome-ignore-all lint/suspicious/noExplicitAny: Adapter request-map bridges canonical ↔ SDK types; casts are intentional.
/**
 * OpenAI Responses request mapper: converts canonical GenerateRequests into
 * OpenAI Responses request bodies (input, tools, reasoning config, response
 * format). Owns the canonical→OpenAI translation.
 *
 * Key decisions:
 * - System messages are extracted into the top-level `instructions` param
 *   because the Responses API has no system-message role in its `input` array.
 * - Assistant messages with tool calls are flattened: text parts become a
 *   message item, tool_use parts become separate `function_call` items, and
 *   reasoning parts with matching provider/model origin become reasoning items.
 *   This mirrors the Responses API's input-item model where each output type
 *   is a distinct item.
 * - Reasoning replay: encrypted reasoning content is only sent back to the
 *   same provider/model pair to avoid cross-provider rejection.
 * - `include: ["reasoning.encrypted_content"]` is always requested so reasoning
 *   items can be carried across turns in stateless mode (per OpenAI reasoning
 *   guide).
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

// ── Content parts mapping ─────────────────────────────────────────
//
// Canonical ContentPart → OpenAI Responses `input` content items.
// Images use input_image (URL or base64 data-URI), text uses input_text,
// files become a text placeholder (Responses has no native file input item).
//

type ResponseInputContent = OpenAI.Responses.ResponseInputContent;

function mapContentPartToResponseInput(part: ContentPart): ResponseInputContent | null {
  switch (part.type) {
    case "text":
      return part.text.length > 0 ? { type: "input_text", text: part.text } : null;
    case "image": {
      const data = part.data instanceof URL ? part.data.href : part.data;
      if (data.startsWith("http://") || data.startsWith("https://")) {
        return {
          type: "input_image",
          image_url: data,
        } as any;
      }
      return {
        type: "input_image",
        image_url: `data:${part.mediaType};base64,${data}`,
      } as any;
    }
    case "file":
      return { type: "input_text", text: `[file: ${part.filename ?? "unknown"}]` };
    default:
      return null;
  }
}

// ── Message mapping ───────────────────────────────────────────────
//
// Canonical Message → OpenAI Responses input items.
// System messages are extracted into `instructions`; tool results become
// function_call_output items; assistant output is split into separate
// message/function_call/reasoning items per the Responses input model.
//

function textFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

function matchesReasoningOrigin(
  part: Extract<ContentPart, { type: "reasoning" }>,
  targetProviderId: string,
  targetModelId: string,
) {
  const origin = part.providerOptions?.meridian;
  return origin?.provider === targetProviderId && origin?.model === targetModelId;
}

function mapReasoningPartToResponseInput(
  part: Extract<ContentPart, { type: "reasoning" }>,
  targetProviderId: string,
  targetModelId: string,
): ResponseInputItem | null {
  if (!matchesReasoningOrigin(part, targetProviderId, targetModelId)) return null;

  const openai = part.providerOptions?.openai;
  const itemId = openai?.itemId;
  const encrypted = openai?.encrypted;
  if (typeof itemId !== "string" || typeof encrypted !== "string") return null;

  return {
    type: "reasoning",
    id: itemId,
    encrypted_content: encrypted,
    summary: [],
  } as any;
}

function mapMessage(message: Message): ResponseInputItem | null {
  // System messages are handled via `instructions` param
  if (message.role === "system") return null;

  // Tool result → function_call_output
  if (message.role === "tool") {
    const result = message.content.find((p) => p.type === "tool_result");
    if (result) {
      return {
        type: "function_call_output",
        call_id: result.toolCallId,
        output: safeToolOutput(result.output),
      } as any;
    }
    return null;
  }

  // Assistant messages with tool calls → function_call items
  if (message.role === "assistant") {
    const toolUses = message.content.filter((p) => p.type === "tool_use");
    if (toolUses.length > 0) {
      // Return an array would be better but the SDK expects single items
      // We'll handle this by flattening in the caller
      // For now, return the message + tool calls will be handled separately
    }
  }

  const role = message.role;

  // Simple text-only
  const hasOnlyText = message.content.every((p) => p.type === "text");
  if (hasOnlyText) {
    const content = textFromParts(message.content);
    if (content.length === 0) return null;
    return {
      role,
      content,
      type: "message",
    } as any;
  }

  // Mixed content
  const contentParts = message.content
    .map(mapContentPartToResponseInput)
    .filter((p): p is ResponseInputContent => p !== null);

  if (contentParts.length === 0) return null;

  return {
    role,
    content: contentParts,
    type: "message",
  } as any;
}

function flattenAssistantToolCalls(
  messages: Message[],
  targetProviderId: string,
  targetModelId: string,
): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const toolUses = message.content.filter((p) => p.type === "tool_use");
      for (const reasoning of message.content.filter((p) => p.type === "reasoning")) {
        const mapped = mapReasoningPartToResponseInput(reasoning, targetProviderId, targetModelId);
        if (mapped) items.push(mapped);
      }

      // Emit message content first (text parts)
      const textContent = message.content.filter((p) => p.type === "text");
      if (textContent.length > 0 || toolUses.length === 0) {
        const mapped = mapMessage({
          ...message,
          content: textContent.length > 0 ? textContent : message.content,
        });
        if (mapped) items.push(mapped);
      }

      // Emit tool calls as separate function_call items
      for (const tu of toolUses) {
        if (tu.type === "tool_use") {
          items.push({
            type: "function_call",
            call_id: tu.toolCallId,
            name: tu.toolName,
            arguments: JSON.stringify(tu.input),
          } as any);
        }
      }
    } else {
      const mapped = mapMessage(message);
      if (mapped) items.push(mapped);
    }
  }

  return items;
}

/**
 * Extract system prompt from messages for the `instructions` param.
 * The Responses API accepts instructions as a top-level string rather than
 * as a system-message role in the `input` array.
 */

function extractInstructions(messages: Message[]): string | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;
  return systemMessages.map((m) => textFromParts(m.content)).join("\n");
}

// ── Tool mapping ──────────────────────────────────────────────────
//
// Canonical Tool[] → OpenAI Responses Tool[]. Function tools become `function`
// tools; hosted tools map to web_search_preview, code_interpreter, or
// file_search with vector_store_ids from providerOptions.
//

type ResponsesTool = OpenAI.Responses.Tool;

function mapTools(tools: Tool[] | undefined): ResponsesTool[] | undefined {
  if (!tools?.length) return undefined;

  const mapped: ResponsesTool[] = [];
  for (const tool of tools) {
    if (tool.type === "function") {
      const ft = tool as FunctionTool;
      mapped.push({
        type: "function",
        name: ft.name,
        description: ft.description,
        parameters: ft.inputSchema,
        strict: false,
      } as any);
    } else if (tool.type === "hosted") {
      if (tool.kind === "web_search") {
        mapped.push({ type: "web_search_preview" } as any);
      } else if (tool.kind === "code_execution") {
        mapped.push({ type: "code_interpreter" } as any);
      } else if (tool.kind === "file_search") {
        const vectorStoreIds = (tool.providerOptions?.openai?.vectorStoreIds ?? []) as string[];
        mapped.push({
          type: "file_search",
          vector_store_ids: vectorStoreIds,
        } as any);
      }
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

// ── Tool choice mapping ───────────────────────────────────────────
//
// Canonical toolChoice → OpenAI Responses tool_choice. `required` maps to
// `required` (Responses supports it natively); `auto`/`none`/named tool
// map directly.
//

function mapToolChoice(
  toolChoice: GenerateRequest["toolChoice"],
): OpenAI.Responses.ToolChoiceOptions | OpenAI.Responses.ToolChoiceFunction | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "object" && "tool" in toolChoice) {
    return { type: "function", name: toolChoice.tool };
  }
  return undefined;
}

// ── Reasoning config ──────────────────────────────────────────────
//
// Canonical reasoning → OpenAI Responses reasoning config.
// `adaptive` maps to effort=medium + summary=auto. `max` effort is clamped
// to `high` because the Responses API only supports low/medium/high.
// The summary field requests auto-summarization of reasoning.
//

function mapReasoning(
  reasoning: GenerateRequest["reasoning"],
):
  | { effort?: "low" | "medium" | "high" | null; summary?: "auto" | "concise" | "detailed" | null }
  | undefined {
  if (!reasoning || reasoning === "disabled") return undefined;

  if (reasoning === "adaptive") {
    return { effort: "medium", summary: "auto" };
  }

  const effort = typeof reasoning === "object" ? reasoning.effort : "medium";
  // OpenAI only supports low/medium/high, not "max"
  const mappedEffort = effort === "max" ? "high" : effort;
  return { effort: mappedEffort as "low" | "medium" | "high", summary: "auto" };
}

// ── Response format mapping ───────────────────────────────────────
//
// Canonical responseFormat → OpenAI Responses text config.
// json → json_object format; json_schema → json_schema format with
// name/schema/strict. `text` type means no format constraint (undefined).
//

function mapResponseFormat(
  format: GenerateRequest["responseFormat"],
): OpenAI.Responses.ResponseTextConfig | undefined {
  if (!format || format.type === "text") return undefined;

  if (format.type === "json") {
    return {
      format: { type: "json_object" },
    } as any;
  }

  if (format.type === "json_schema") {
    return {
      format: {
        type: "json_schema",
        name: format.name ?? "response",
        schema: format.schema,
        strict: format.strict ?? true,
      },
    } as any;
  }

  return undefined;
}

// ── Public: build Responses API params ────────────────────────────
//
// Assembles the full ResponseCreateParamsStreaming from a canonical
// GenerateRequest. Always sets stream:true; always includes
// "reasoning.encrypted_content" in `include` so reasoning items survive
// round-trips in stateless mode (OpenAI reasoning guide).
//

export function toOpenAIResponsesParams(
  request: GenerateRequest,
  modelId: string,
  providerId = "openai",
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const instructions = extractInstructions(request.messages);
  const input = flattenAssistantToolCalls(request.messages, providerId, modelId);

  return {
    model: modelId,
    input,
    stream: true,
    include: ["reasoning.encrypted_content" as const],
    ...(instructions ? { instructions } : {}),
    ...(mapTools(request.tools) ? { tools: mapTools(request.tools) } : {}),
    ...(mapToolChoice(request.toolChoice)
      ? { tool_choice: mapToolChoice(request.toolChoice) }
      : {}),
    ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(mapReasoning(request.reasoning) ? { reasoning: mapReasoning(request.reasoning) } : {}),
    ...(mapResponseFormat(request.responseFormat)
      ? { text: mapResponseFormat(request.responseFormat) }
      : {}),
  };
}
