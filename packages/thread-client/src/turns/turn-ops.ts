/**
 * Pure turn-list operations behind `TurnStore.ensureAssistantTurn`,
 * `upsertAssistantBlock` and `patchTurnStatus`. Every store (the app's Zustand
 * adapter and `InMemoryTurnStore`) calls these, so the semantics exist once.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { baseTurnFields } from "./state-helpers";

export type EnsureAssistantTurnOptions = {
  createdAt?: string;
  prevTurnId?: string | null;
  writeMode?: Turn["writeMode"];
};

export type TurnStatusPatch = Partial<
  Pick<
    Turn,
    | "completedAt"
    | "usage"
    | "error"
    | "finishReason"
    | "inputTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "totalCostUsd"
    | "totalMillicredits"
    | "responseCount"
  >
>;

export function createAssistantTurn(
  threadId: string,
  turnId: string,
  createdAt: string,
  existingTurns: readonly Turn[],
  opts?: EnsureAssistantTurnOptions,
): Turn {
  const previousTurn = existingTurns.at(-1);
  const prevTurnId =
    opts && "prevTurnId" in opts ? (opts.prevTurnId ?? null) : (previousTurn?.id ?? null);
  return {
    id: turnId,
    threadId,
    position: 0,
    prevTurnId,
    role: "assistant",
    origin: "assistant",
    writeMode: opts?.writeMode ?? null,
    status: "streaming",
    promptBakeId: null,
    finishReason: null,
    ...baseTurnFields(),
    error: null,
    createdAt: opts?.createdAt ?? createdAt,
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export type EnsureAssistantTurnResult =
  /** A non-assistant turn owns the id; nothing changes. */
  | { kind: "rejected" }
  /** The assistant turn exists; `turns` is the same array unless writeMode changed. */
  | { kind: "existing"; turns: Turn[] }
  | { kind: "created"; turns: Turn[]; turn: Turn };

export function ensureAssistantTurnIn(
  existing: Turn[],
  threadId: string,
  turnId: string,
  createdAt: string,
  opts?: EnsureAssistantTurnOptions,
): EnsureAssistantTurnResult {
  const existingTurn = existing.find((turn) => turn.id === turnId);
  if (existingTurn) {
    if (existingTurn.role !== "assistant") return { kind: "rejected" };
    const turns =
      opts?.writeMode !== undefined && existingTurn.writeMode !== opts.writeMode
        ? existing.map((turn) =>
            turn.id === turnId ? { ...turn, writeMode: opts.writeMode ?? null } : turn,
          )
        : existing;
    return { kind: "existing", turns };
  }
  const turn = createAssistantTurn(threadId, turnId, createdAt, existing, opts);
  return { kind: "created", turns: [...existing, turn], turn };
}

/**
 * Replaces the block at `block.sequence`, keeps blocks sorted, and returns null
 * when the turn is unknown or the block is identical (callers skip the write).
 */
export function upsertBlockIn(turns: Turn[], turnId: string, block: Block): Turn[] | null {
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  const turn = turns[turnIndex];
  if (!turn) return null;
  const normalized = block.turnId === turnId ? block : { ...block, turnId };
  const current = turn.blocks.find((existing) => existing.sequence === block.sequence);
  if (current && sameBlock(current, normalized)) return null;
  const blocks = [
    ...turn.blocks.filter((existing) => existing.sequence !== block.sequence),
    normalized,
  ].sort((a, b) => a.sequence - b.sequence);
  return turns.map((existing, index) => (index === turnIndex ? { ...existing, blocks } : existing));
}

/** Patches one turn's status; undefined patch fields are ignored. Null when the turn is unknown. */
export function patchTurnStatusIn(
  turns: Turn[],
  turnId: string,
  status: Turn["status"],
  patch: TurnStatusPatch = {},
): Turn[] | null {
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex < 0) return null;
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as TurnStatusPatch;
  return turns.map((turn, index) => (index === turnIndex ? { ...turn, ...defined, status } : turn));
}

function sameBlock(left: Block, right: Block): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.responseId === right.responseId &&
    left.blockType === right.blockType &&
    left.sequence === right.sequence &&
    left.textContent === right.textContent &&
    left.provider === right.provider &&
    left.executionSide === right.executionSide &&
    left.status === right.status &&
    sameJson(left.content, right.content) &&
    sameJson(left.providerData, right.providerData) &&
    sameJson(left.collapsedContent, right.collapsedContent)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
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
