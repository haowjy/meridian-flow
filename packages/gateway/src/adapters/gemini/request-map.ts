/**
 * Gemini request mapper: converts canonical GenerateRequests into native `generateContent`
 * parameters (contents, systemInstruction, tools, thinking).
 *
 * Key decisions:
 * - Roles are `user` and `model`; a tool result is a `functionResponse` part in a user turn, so
 *   adjacent messages of one role merge into one turn (parallel results must share a turn).
 *   `functionResponse` names its function, which the canonical result lacks: the name comes from
 *   the earlier `tool_use` with the same call id. Gemini 3 also gets the id on both sides.
 * - Media: a link is `fileData` (`https` only, a mapper never downloads), bytes are
 *   `inlineData`. A tool result's media nest in `functionResponse.parts`, Gemini 3 and later
 *   only; for an older or unknown model that is an error here and `placeMedia` answers none.
 * - Thought signatures: the model's `thoughtSignature` on a text, thought or function-call part
 *   is kept in `providerOptions.gemini.signature` and sent back on the same part, only to the
 *   provider/model pair that issued it. Gemini 3 rejects a replayed function-call step whose
 *   first call carries no signature (history from another model, a compacted turn), so that
 *   call gets Google's documented validator-bypass value.
 * - Prompt caching is implicit: no mark and no TTL is sent.
 */
import type {
  Content,
  FunctionResponse,
  FunctionResponsePart,
  GenerateContentConfig,
  Part,
  ThinkingConfig,
} from "@google/genai";
import type {
  ContentPart,
  GenerateRequest,
  MediaPart,
  Message,
  ModelInfo,
  ResolvedCall,
  TextPart,
  Tool,
} from "../../domain/index.js";
import { geminiMajorVersion, wireMediaSource } from "../../domain/media.js";

/** Google's documented value that skips signature validation on a replayed function call. */
const SKIP_SIGNATURE_VALIDATION = "skip_thought_signature_validator";

/** Reject, at gateway creation, a model with a cache lifetime: implicit caching documents none to send. */
export function assertCacheTtlsOnWire(model: Pick<ModelInfo, "id" | "promptCache">): void {
  if (model.promptCache.shortTtlSeconds !== null || model.promptCache.longTtlSeconds !== null) {
    throw new Error(
      `Gemini implicit caching has no lifetime to send; ${model.id} must declare none`,
    );
  }
}

type Target = Pick<ModelInfo, "id" | "provider" | "wire">;

function mediaPart(part: MediaPart, target: Target): Part {
  const media = wireMediaSource(target, part);
  return "url" in media
    ? { fileData: { fileUri: media.url, mimeType: part.mediaType } }
    : { inlineData: { data: media.data, mimeType: media.mediaType } };
}

function functionResponsePart(part: MediaPart, target: Target): FunctionResponsePart {
  const { fileData, inlineData } = mediaPart(part, target);
  return fileData
    ? { fileData: { fileUri: fileData.fileUri, mimeType: fileData.mimeType } }
    : { inlineData: { data: inlineData?.data, mimeType: inlineData?.mimeType } };
}

/**
 * Gemini 3 returns an id on each function call and pairs a result by it, so parallel calls to
 * one tool stay distinct; an older model has none and pairs by name and order.
 */
function callId(toolCallId: string, target: Target): { id?: string } {
  return (geminiMajorVersion(target.id) ?? 0) >= 3 ? { id: toolCallId } : {};
}

function textOf(parts: ReadonlyArray<TextPart | { type: string }>): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function signatureFor(
  part: Extract<ContentPart, { type: "text" | "reasoning" | "tool_use" }>,
  target: Target,
): string | undefined {
  const origin = part.providerOptions?.meridian;
  if (origin?.provider !== target.provider || origin?.model !== target.id) return undefined;
  const signature = part.providerOptions?.gemini?.signature;
  return typeof signature === "string" ? signature : undefined;
}

function userParts(message: Message, target: Target): Part[] {
  const parts: Part[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.length > 0) parts.push({ text: part.text });
    else if (part.type === "media") parts.push(mediaPart(part, target));
  }
  return parts;
}

function modelParts(message: Message, target: Target): Part[] {
  const parts: Part[] = [];
  let firstCall = true;
  for (const part of message.content) {
    if (part.type !== "reasoning" && part.type !== "text" && part.type !== "tool_use") continue;
    const thoughtSignature = signatureFor(part, target);
    if (part.type === "reasoning") {
      // A summary without its signature carries nothing the API needs back.
      if (thoughtSignature) parts.push({ text: part.text, thought: true, thoughtSignature });
    } else if (part.type === "text") {
      if (part.text.length > 0 || thoughtSignature) {
        parts.push({ text: part.text, ...(thoughtSignature ? { thoughtSignature } : {}) });
      }
    } else if (part.type === "tool_use") {
      const signature =
        thoughtSignature ??
        (firstCall && (geminiMajorVersion(target.id) ?? 0) >= 3
          ? SKIP_SIGNATURE_VALIDATION
          : undefined);
      parts.push({
        functionCall: { ...callId(part.toolCallId, target), name: part.toolName, args: part.input },
        ...(signature ? { thoughtSignature: signature } : {}),
      });
      firstCall = false;
    }
  }
  return parts;
}

function toolResultParts(message: Message, names: Map<string, string>, target: Target): Part[] {
  const parts: Part[] = [];
  for (const result of message.content) {
    if (result.type !== "tool_result") continue;
    const name = names.get(result.toolCallId);
    if (name === undefined) {
      throw new Error(`Tool result ${result.toolCallId} has no matching tool call to name`);
    }
    const media = result.content.filter((p) => p.type === "media");
    if (media.length > 0 && (geminiMajorVersion(target.id) ?? 0) < 3) {
      throw new Error(
        `${target.id} takes no media inside a function response (Gemini 3 and later)`,
      );
    }
    const text = textOf(result.content);
    const functionResponse: FunctionResponse = {
      ...callId(result.toolCallId, target),
      name,
      response: result.isError ? { error: text } : { output: text },
      ...(media.length > 0 ? { parts: media.map((p) => functionResponsePart(p, target)) } : {}),
    };
    parts.push({ functionResponse });
  }
  return parts;
}

function mapContents(messages: Message[], target: Target): Content[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_use") names.set(part.toolCallId, part.toolName);
    }
  }
  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts =
      message.role === "tool"
        ? toolResultParts(message, names, target)
        : message.role === "assistant"
          ? modelParts(message, target)
          : userParts(message, target);
    if (parts.length === 0) continue;
    const last = contents.at(-1);
    if (last?.role === role) last.parts?.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function mapTools(tools: Tool[] | undefined): GenerateContentConfig["tools"] {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })),
    },
  ];
}

/**
 * `default` and an effort ask for thought summaries so reasoning streams; `off` sends a zero
 * budget. `max` has no Gemini level above `high`, and no registered Gemini model lists it.
 */
function mapThinking(reasoning: ResolvedCall["reasoning"]): ThinkingConfig {
  if (reasoning === "off") return { thinkingBudget: 0 };
  if (reasoning === "default") return { includeThoughts: true };
  const level = { low: "LOW", medium: "MEDIUM", high: "HIGH", max: "HIGH" }[reasoning.effort];
  return { includeThoughts: true, thinkingLevel: level as ThinkingConfig["thinkingLevel"] };
}

export interface GeminiParams {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}

export function toGeminiParams(
  request: GenerateRequest,
  model: Pick<ModelInfo, "id" | "provider" | "wire">,
  call: ResolvedCall,
): GeminiParams {
  const system = request.messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter((text) => text.length > 0)
    .join("\n");
  return {
    model: model.id,
    contents: mapContents(request.messages, model),
    config: {
      ...(system ? { systemInstruction: system } : {}),
      tools: mapTools(request.tools),
      thinkingConfig: mapThinking(call.reasoning),
      // The gateway owns the loop and the request count: no SDK tool loop, no re-sent requests.
      automaticFunctionCalling: { disable: true },
      automaticContinuation: false,
      abortSignal: request.signal,
    },
  };
}
