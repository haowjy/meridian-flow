/**
 * Pure turn-list operations behind `TurnStore.ensureAssistantTurn`,
 * `upsertAssistantBlock` and `patchTurnStatus`. Every store (the app's Zustand
 * adapter and `InMemoryTurnStore`) calls these, so the semantics exist once.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { compareSeq } from "@meridian/contracts/protocol";
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
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
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

/** Turns that left the conversation, by id, with the stream seq of the frame that removed them. */
export type Tombstones = ReadonlyMap<string, string>;

/**
 * A thread's turns with the tombstones of turns removed from them. A snapshot read before a
 * removal still lists the turn, so removal alone is not enough: the tombstone keeps it gone
 * until a snapshot that covers the removal arrives.
 */
export type TurnsWithTombstones = { turns: Turn[]; tombstones: Tombstones };

/**
 * Removes the named turns (a `meridian.messages.handed_back` frame, or the same fact in a
 * hand-back answer) and keeps a tombstone for each. Applying it again changes nothing, so the
 * frame and the HTTP answer may both call it. The later seq of two removals of one id wins.
 */
export function removeTurnsIn(
  state: TurnsWithTombstones,
  ids: readonly string[],
  seq: string,
): TurnsWithTombstones {
  const drop = new Set(ids);
  const turns = state.turns.filter((turn) => !drop.has(turn.id));
  let tombstones: Map<string, string> | null = null;
  for (const id of drop) {
    const held = state.tombstones.get(id);
    if (held !== undefined && compareSeq(held, seq) >= 0) continue;
    tombstones ??= new Map(state.tombstones);
    tombstones.set(id, seq);
  }
  if (turns.length === state.turns.length && !tombstones) return state;
  return { turns, tombstones: tombstones ?? state.tombstones };
}

/**
 * A server snapshot's turns, less those a removal the snapshot does not cover has taken out;
 * tombstones the snapshot covers (`seq < nextSeq`) go, because its turn list lacks them from
 * then on.
 */
export function applySnapshotTo(
  tombstones: Tombstones,
  serverTurns: readonly Turn[],
  nextSeq: string,
): { turns: Turn[]; tombstones: Tombstones } {
  const live = new Map([...tombstones].filter(([, seq]) => compareSeq(seq, nextSeq) >= 0));
  return {
    turns: live.size ? serverTurns.filter((turn) => !live.has(turn.id)) : [...serverTurns],
    tombstones: live.size === tombstones.size ? tombstones : live,
  };
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
