/**
 * Gemini stream accumulator: folds `streamGenerateContent` chunks into canonical StreamEvents
 * and a final GenerateResult.
 *
 * - Parts arrive in order: thought summaries (`thought: true`), text, and complete function
 *   calls (Gemini never streams call arguments in pieces). Content keeps that order; text and
 *   thought runs merge into one part until the kind changes.
 * - A `thoughtSignature` arrives on a text, thought or function-call part, sometimes on an empty
 *   trailing text part. It is kept in `providerOptions.gemini.signature` beside the issuing
 *   provider/model, and the request mapper sends it back to that pair only.
 * - Usage is cumulative on every chunk. Gemini counts thought tokens beside the answer's, and
 *   tool-use prompt tokens beside the prompt's; `Usage` is inclusive, so both are folded in. A file
 *   fetched by link appears only in `totalTokenCount`, so the input is read from that total.
 * - A function call may carry no id (before Gemini 3); the position-based `call_<n>` stands in,
 *   and the mapper sends an id back only to Gemini 3 and later, which returns real ones.
 */
import type { GenerateContentResponse, Part } from "@google/genai";
import type {
  ContentPart,
  FinishReason,
  GenerateResult,
  ModelInfo,
  ProviderOptions,
  StreamEvent,
  ToolCall,
} from "../../domain/index.js";
import { assertValidUsage, type Usage } from "../../shapes/index.js";

export interface StreamAccumulator {
  content: ContentPart[];
  usage: Usage;
  finishReason: FinishReason;
  model: string;
  provider: string;
}

export function createStreamAccumulator(
  model: Pick<ModelInfo, "id">,
  provider: string,
): StreamAccumulator {
  return {
    content: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: "end_turn",
    model: model.id,
    provider,
  };
}

/** Gemini's finish reasons that mean the output was cut or refused; everything else is a normal stop. */
function mapFinishReason(reason: string | undefined): FinishReason | undefined {
  if (reason === undefined || reason === "STOP" || reason === "FINISH_REASON_UNSPECIFIED") {
    return undefined;
  }
  return reason === "MAX_TOKENS" || reason === "CONTINUATION" ? "max_tokens" : "error";
}

function usageOf(metadata: NonNullable<GenerateContentResponse["usageMetadata"]>): Usage {
  const thoughts = metadata.thoughtsTokenCount ?? 0;
  const cached = metadata.cachedContentTokenCount ?? 0;
  const outputTokens = (metadata.candidatesTokenCount ?? 0) + thoughts;
  // A file fetched by link is counted in `totalTokenCount` only: `promptTokenCount` is absent.
  const inputTokens = Math.max(
    (metadata.promptTokenCount ?? 0) + (metadata.toolUsePromptTokenCount ?? 0),
    (metadata.totalTokenCount ?? 0) - outputTokens,
  );
  const usage: Usage = {
    inputTokens,
    outputTokens,
    ...(thoughts ? { reasoningTokens: thoughts } : {}),
    ...(cached ? { cacheReadTokens: cached } : {}),
  };
  assertValidUsage(usage);
  return usage;
}

function sameUsage(a: Usage, b: Usage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.cacheReadTokens === b.cacheReadTokens
  );
}

function withSignature(signature: string, acc: StreamAccumulator): ProviderOptions {
  return {
    gemini: { signature },
    meridian: { provider: acc.provider, model: acc.model },
  };
}

function* eventsFromPart(part: Part, acc: StreamAccumulator): Generator<StreamEvent> {
  const signature = part.thoughtSignature;
  if (part.functionCall) {
    const { name = "", args = {}, id } = part.functionCall;
    const callId = id ?? `call_${acc.content.filter((p) => p.type === "tool_use").length}`;
    acc.content.push({
      type: "tool_use",
      toolCallId: callId,
      toolName: name,
      input: args,
      ...(signature ? { providerOptions: withSignature(signature, acc) } : {}),
    });
    yield { type: "tool_call.delta", id: callId, name, argumentsDelta: JSON.stringify(args) };
    return;
  }
  if (part.text === undefined) return;
  const kind = part.thought ? "reasoning" : "text";
  if (part.text.length === 0 && !signature) return;
  const last = acc.content.at(-1);
  let target: Extract<ContentPart, { type: "text" | "reasoning" }>;
  if (last?.type === kind) target = last;
  else {
    target = { type: kind, text: "" };
    acc.content.push(target);
  }
  target.text += part.text;
  if (signature) target.providerOptions = withSignature(signature, acc);
  if (part.text.length > 0) {
    yield kind === "reasoning"
      ? { type: "reasoning.delta", text: part.text }
      : { type: "text.delta", text: part.text };
  }
}

export function* eventsFromGeminiChunk(
  chunk: GenerateContentResponse,
  acc: StreamAccumulator,
): Generator<StreamEvent> {
  if (chunk.usageMetadata) {
    const usage = usageOf(chunk.usageMetadata);
    if (!sameUsage(usage, acc.usage)) {
      acc.usage = usage;
      yield { type: "usage", usage };
    }
  }
  // A blocked prompt comes with no candidate at all.
  if (chunk.promptFeedback?.blockReason) acc.finishReason = "error";
  const candidate = chunk.candidates?.[0];
  if (!candidate) return;
  for (const part of candidate.content?.parts ?? []) yield* eventsFromPart(part, acc);
  const reason = mapFinishReason(candidate.finishReason);
  if (reason) acc.finishReason = reason;
}

export function buildGenerateResult(acc: StreamAccumulator): GenerateResult {
  const toolCalls: ToolCall[] = acc.content.flatMap((part) =>
    part.type === "tool_use"
      ? [{ id: part.toolCallId, name: part.toolName, arguments: part.input }]
      : [],
  );
  // A refusal or a cut-off call is not executable, even when a call was assembled.
  const finishReason =
    acc.finishReason === "end_turn" && toolCalls.length > 0 ? "tool_use" : acc.finishReason;
  return {
    content: [...acc.content],
    toolCalls,
    finishReason,
    usage: acc.usage,
    model: acc.model,
    provider: acc.provider,
  };
}
