/** Conservative, provider-neutral input-token estimate for a request and its incremental messages. */

import type { GenerateRequest } from "../../gateway/index.js";

const TOKEN_BYTES_PER_TOKEN = 3;
const encoder = new TextEncoder();
export const IMAGE_PART_TOKEN_ESTIMATE = 1_600;
export const FILE_PART_TOKEN_ESTIMATE = 10_000;
// Budget three tokens per CJK code point: a deliberate 3x margin over bytes/3 until C4e probes it.
export const CJK_CODE_POINT_TOKEN_MULTIPLIER = 3;

function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").byteLength;
}

function tokensForBytes(bytes: number): number {
  return Math.ceil(bytes / TOKEN_BYTES_PER_TOKEN);
}

function isCjkCodePoint(point: number): boolean {
  return (
    (point >= 0x2e80 && point <= 0x9fff) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0x20000 && point <= 0x3134f) ||
    (point >= 0x3040 && point <= 0x30ff) ||
    (point >= 0x31f0 && point <= 0x31ff) ||
    (point >= 0xac00 && point <= 0xd7af)
  );
}

function textTokens(text: string): number {
  let cjkBytes = 0;
  let cjkCodePoints = 0;
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point !== undefined && isCjkCodePoint(point)) {
      cjkBytes += encoder.encode(character).byteLength;
      cjkCodePoints++;
    }
  }
  const bytes = encoder.encode(text).byteLength;
  return tokensForBytes(bytes - cjkBytes) + cjkCodePoints * CJK_CODE_POINT_TOKEN_MULTIPLIER;
}

function messageTokens(message: GenerateRequest["messages"][number]): number {
  let contentTokens = 0;
  const structure = {
    ...message,
    content: message.content.map((part) => {
      switch (part.type) {
        case "text":
          contentTokens += textTokens(part.text);
          return { ...part, text: "" };
        case "image": {
          contentTokens += IMAGE_PART_TOKEN_ESTIMATE;
          const { data: _data, ...withoutData } = part;
          return withoutData;
        }
        case "file": {
          contentTokens += FILE_PART_TOKEN_ESTIMATE;
          const { data: _data, ...withoutData } = part;
          return withoutData;
        }
        default:
          return part;
      }
    }),
  };
  return contentTokens + tokensForBytes(encodedBytes(structure));
}

function messagesTokens(messages: GenerateRequest["messages"]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/**
 * Estimates full input, or a baseline plus only messages appended after its messageCount.
 * Image and file payload bytes are never measured; each part uses its per-type estimate.
 */
export function estimateRequestTokens(input: {
  request: Pick<GenerateRequest, "messages"> &
    Partial<Pick<GenerateRequest, "tools" | "responseFormat">>;
  baseline: { inputTokens: number; messageCount: number } | null;
}): number {
  if (input.baseline) {
    const messageCount = Math.max(0, Math.floor(input.baseline.messageCount));
    return (
      Math.max(0, input.baseline.inputTokens) +
      messagesTokens(input.request.messages.slice(messageCount))
    );
  }

  return (
    messagesTokens(input.request.messages) +
    tokensForBytes(
      encodedBytes({
        tools: input.request.tools ?? [],
        responseFormat: input.request.responseFormat ?? null,
      }),
    )
  );
}
