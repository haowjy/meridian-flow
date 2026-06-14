// @ts-nocheck
/**
 * state-helpers — small pure utilities shared by the session reducer and store.
 *
 * The old frontier fold helpers were deleted with the unified-block collapse;
 * this file now keeps only JSON/block primitives that do not carry live state.
 */
import type { Block, JsonValue } from "@meridian/contracts/protocol";

export function toBlockContent(value: JsonValue): JsonValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value : { value };
}

export function baseTurnFields() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null as number | null,
    cacheReadTokens: null as number | null,
    cacheWriteTokens: null as number | null,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
  };
}

export function nextBlockSequence(blocks: readonly Block[]): number {
  return blocks.reduce((max, block) => Math.max(max, block.sequence), -1) + 1;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseToolOutput(value: unknown): JsonValue {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  return (value as JsonValue) ?? null;
}

export function eventH(event: object): event is { threadId: string } {
  return "threadId" in event && typeof (event as { threadId?: unknown }).threadId === "string";
}
