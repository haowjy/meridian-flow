/** Shared per-part and request-level token estimates for planning and delivery checks. */

import type { Block, Turn } from "@meridian/contracts/threads";
import type { GenerateRequest, TokenizerFamily } from "../../gateway/index.js";

const TOKEN_BYTES_PER_TOKEN = 3;
const encoder = new TextEncoder();
export const IMAGE_PART_TOKEN_ESTIMATE = 1_600;
export const FILE_PART_TOKEN_ESTIMATE = 10_000;
/** Conservative CJK code-point rates; refresh from published or live probe evidence. */
export const CJK_CODE_POINT_TOKEN_RATES: Record<TokenizerFamily, number> = {
  anthropic: 3.0,
  o200k: 1.1,
  gemini: 1.2,
  deepseek: 0.8,
};

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

function textTokens(text: string, tokenizer: TokenizerFamily): number {
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
  return tokensForBytes(bytes - cjkBytes) + cjkCodePoints * CJK_CODE_POINT_TOKEN_RATES[tokenizer];
}

function blankStrings(value: unknown): unknown {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map(blankStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, blankStrings(entry)]),
    );
  }
  return value;
}

function stringTokens(value: unknown, tokenizer: TokenizerFamily): number {
  if (typeof value === "string") return textTokens(value, tokenizer);
  if (Array.isArray(value))
    return value.reduce((sum, entry) => sum + stringTokens(entry, tokenizer), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce((sum, entry) => sum + stringTokens(entry, tokenizer), 0);
  }
  return 0;
}

/** Estimates JSON-visible strings with the shared CJK policy plus their structural bytes. */
export function estimateModelJsonTokens(value: unknown, tokenizer: TokenizerFamily): number {
  return Math.ceil(
    stringTokens(value, tokenizer) + tokensForBytes(encodedBytes(blankStrings(value))),
  );
}

/** Estimates one model content part; image/file payload bytes are replaced by fixed costs. */
export function estimateModelPartTokens(part: unknown, tokenizer: TokenizerFamily): number {
  if (part === null || typeof part !== "object" || Array.isArray(part))
    return estimateModelJsonTokens(part, tokenizer);

  const record = part as Record<string, unknown>;
  if (record.type === "image") {
    const { data: _payload, ...withoutPayload } = record;
    return IMAGE_PART_TOKEN_ESTIMATE + estimateModelJsonTokens(withoutPayload, tokenizer);
  }
  if (record.type === "file") {
    const { data: _payload, ...withoutPayload } = record;
    const fileTextTokens =
      typeof record.data === "string"
        ? estimateModelJsonTokens(record.data, tokenizer)
        : record.data instanceof URL
          ? estimateModelJsonTokens(record.data.href, tokenizer)
          : 0;
    return (
      Math.max(FILE_PART_TOKEN_ESTIMATE, fileTextTokens) +
      estimateModelJsonTokens(withoutPayload, tokenizer)
    );
  }
  return estimateModelJsonTokens(record, tokenizer);
}

function blockModelPart(block: Block): unknown {
  const content =
    block.content !== null && typeof block.content === "object" && !Array.isArray(block.content)
      ? (block.content as Record<string, unknown>)
      : {};
  switch (block.blockType) {
    case "text":
      return {
        type: "text",
        text:
          block.textContent ??
          (typeof content.text === "string"
            ? content.text
            : typeof block.content === "string"
              ? block.content
              : ""),
      };
    case "reasoning":
      return {
        type: "reasoning",
        ...content,
        text: typeof content.text === "string" ? content.text : (block.textContent ?? ""),
      };
    case "image":
    case "file":
    case "tool_use":
    case "tool_result":
      return { type: block.blockType, ...content };
    default:
      return { type: block.blockType, content: block.content };
  }
}

/** Default planner estimate for durable turn/block rows, using request per-part rules. */
export function estimateTurnTokens(
  turn: Turn,
  blocks: readonly Block[],
  tokenizer: TokenizerFamily,
): number {
  const headerTokens = estimateModelJsonTokens(
    { role: turn.role, metadata: turn.metadata },
    tokenizer,
  );
  return (
    headerTokens +
    blocks
      .filter((block) => !block.pruned)
      .reduce((sum, block) => sum + estimateModelPartTokens(blockModelPart(block), tokenizer), 0)
  );
}

function messageTokens(
  message: GenerateRequest["messages"][number],
  tokenizer: TokenizerFamily,
): number {
  const { content, ...envelope } = message;
  return (
    estimateModelJsonTokens(envelope, tokenizer) +
    content.reduce((sum, part) => sum + estimateModelPartTokens(part, tokenizer), 0)
  );
}

function messagesTokens(messages: GenerateRequest["messages"], tokenizer: TokenizerFamily): number {
  return messages.reduce((sum, message) => sum + messageTokens(message, tokenizer), 0);
}

/**
 * Estimates full input, or a baseline plus only messages appended after its messageCount.
 * Both this check and compaction planning use estimateModelPartTokens for content parts.
 */
export function estimateRequestTokens(input: {
  tokenizer: TokenizerFamily;
  request: Pick<GenerateRequest, "messages"> &
    Partial<Pick<GenerateRequest, "tools" | "responseFormat">>;
  baseline: { inputTokens: number; messageCount: number } | null;
}): number {
  if (input.baseline) {
    const messageCount = Math.max(0, Math.floor(input.baseline.messageCount));
    return (
      Math.max(0, input.baseline.inputTokens) +
      messagesTokens(input.request.messages.slice(messageCount), input.tokenizer)
    );
  }

  return (
    messagesTokens(input.request.messages, input.tokenizer) +
    estimateModelJsonTokens(
      {
        tools: input.request.tools ?? [],
        responseFormat: input.request.responseFormat ?? null,
      },
      input.tokenizer,
    )
  );
}
