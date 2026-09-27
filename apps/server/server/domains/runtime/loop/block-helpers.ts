/**
 * Shared block-shape helpers for the runtime loop.
 *
 * These functions keep repository create inputs, persisted block events, and
 * in-memory block snapshots aligned without binding the orchestrator to the
 * thread read-model projector. They are pure data transforms except for local
 * UUID/timestamp minting required before persistence events are emitted.
 */

import {
  type Block,
  type BlockUpsertedRow,
  blockPlainText,
  type JsonObject,
  type JsonValue,
} from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type { BlockRepository } from "../../threads/index.js";

// Converts a loose `BlockRepository.create` input (with optional id and
// textContent/content alternatives) into the canonical `BlockUpsertedRow`
// shape used in `block.upserted` events. If no id is provided, one is minted
// locally so the row is self-identifying before persistence.
export function contentForBlockInput(
  input: Parameters<BlockRepository["create"]>[0],
): BlockUpsertedRow {
  return {
    id: input.id ?? crypto.randomUUID(),
    turnId: input.turnId,
    responseId: input.responseId ?? null,
    blockType: input.blockType,
    sequence: input.sequence,
    content: input.content ?? input.textContent ?? null,
    provider: input.provider ?? null,
    status: input.status ?? "complete",
  };
}

// Converts a persisted `BlockUpsertedRow` into the full `Block` contract shape
// for in-memory accumulation. New blocks are never pruned.
export function localBlockFromEvent(block: BlockUpsertedRow): Block {
  return {
    id: block.id,
    turnId: block.turnId,
    responseId: block.responseId ?? null,
    blockType: block.blockType,
    sequence: block.sequence,
    textContent: blockPlainText(block.blockType, block.content),
    content: block.content,
    provider: block.provider ?? null,
    status: block.status,
    pruned: false,
    createdAt: toIsoString(new Date()),
  };
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
