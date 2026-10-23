/** Exhaustive value comparison for the thread store's Turn and Block contracts. */
import type { Block, Turn } from "@meridian/contracts/protocol";

type FieldComparison = "value" | "json";
type TurnFieldComparison = FieldComparison | "separate";

const BLOCK_FIELDS = {
  id: "value",
  turnId: "value",
  responseId: "value",
  blockType: "value",
  sequence: "value",
  textContent: "value",
  content: "json",
  modelText: "value",
  compact: "value",
  provider: "value",
  providerData: "json",
  executionSide: "value",
  status: "value",
  collapsedContent: "value",
  createdAt: "value",
} satisfies Record<keyof Block, FieldComparison>;

const TURN_FIELDS = {
  id: "value",
  threadId: "value",
  position: "value",
  prevTurnId: "value",
  parentTurnId: "value",
  role: "value",
  origin: "value",
  writeMode: "value",
  status: "value",
  executionId: "value",
  reservedForUserTurnIds: "json",
  delivery: "json",
  forgottenBy: "value",
  promptBakeId: "value",
  compactionModel: "value",
  finishReason: "value",
  model: "value",
  provider: "value",
  inputTokens: "value",
  outputTokens: "value",
  reasoningTokens: "value",
  cacheReadTokens: "value",
  cacheWriteTokens: "value",
  totalCostUsd: "value",
  totalMillicredits: "value",
  responseCount: "value",
  usage: "json",
  error: "value",
  requestParams: "json",
  responseMetadata: "json",
  metadata: "json",
  createdAt: "value",
  completedAt: "value",
  blocks: "separate",
  siblingIds: "json",
  responses: "json",
} satisfies Record<keyof Turn, TurnFieldComparison>;

export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]),
    )
  );
}

export function sameBlock(left: Block, right: Block): boolean {
  return (Object.keys(BLOCK_FIELDS) as (keyof Block)[]).every((field) =>
    BLOCK_FIELDS[field] === "json"
      ? sameJson(left[field], right[field])
      : left[field] === right[field],
  );
}

export function sameTurn(left: Turn, right: Turn): boolean {
  return (Object.keys(TURN_FIELDS) as (keyof Turn)[]).every((field) => {
    const comparison = TURN_FIELDS[field];
    if (comparison === "separate") return left.blocks === right.blocks;
    if (comparison === "json") return sameJson(left[field], right[field]);
    return left[field] === right[field];
  });
}
