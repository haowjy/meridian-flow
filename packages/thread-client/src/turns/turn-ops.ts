import type { Block, Turn } from "@meridian/contracts/protocol";
import { compareSeq } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { sameBlock } from "./same-turn";
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
    forgottenBy: null,
    siblingIds: [],
    responses: [],
  };
}

export type EnsureAssistantTurnResult =
  | { kind: "rejected" }
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

export type SwitchTurnFacts = {
  turnId: string;
  controlId: string;
  mode: AiWriteMode;
  prevTurnId: string | null;
  position: number;
};

export type HeldDividers = ReadonlyMap<string, { turn: Turn; seq: string }>;

function placedAfterAnchor(turns: readonly Turn[], turn: Turn): Turn[] | null {
  if (turn.prevTurnId === null) return [turn, ...turns];
  const at = turns.findIndex((candidate) => candidate.id === turn.prevTurnId);
  if (at < 0) return null;
  return [...turns.slice(0, at + 1), turn, ...turns.slice(at + 1)];
}

export function ensureSwitchTurnIn(
  state: { turns: Turn[]; dividers: HeldDividers },
  threadId: string,
  facts: SwitchTurnFacts,
  seq: string,
  createdAt: string,
): { turns: Turn[]; dividers: HeldDividers } {
  const { turns: existing } = state;
  if (existing.some((turn) => turn.id === facts.turnId)) return state;
  const held = state.dividers.get(facts.turnId);
  if (held) {
    const turns = placedAfterAnchor(existing, held.turn);
    return turns ? { turns, dividers: state.dividers } : state;
  }
  const turn: Turn = {
    id: facts.turnId,
    threadId,
    position: facts.position,
    prevTurnId: facts.prevTurnId,
    role: "system",
    origin: "system",
    writeMode: facts.mode,
    status: "complete",
    promptBakeId: null,
    finishReason: null,
    ...baseTurnFields(),
    error: null,
    createdAt,
    completedAt: createdAt,
    blocks: [],
    metadata: {
      kind: "write_mode_switch",
      mode: facts.mode,
      controlMessageId: facts.controlId,
    },
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
    forgottenBy: null,
    siblingIds: [],
    responses: [],
  };
  return {
    turns: placedAfterAnchor(existing, turn) ?? existing,
    dividers: new Map(state.dividers).set(facts.turnId, { turn, seq }),
  };
}

export type AwaitingDivider = { turnId: string; seq: string };

export function dividersAwaitingAnchorIn(state: {
  turns: readonly Turn[];
  dividers: HeldDividers;
}): AwaitingDivider[] {
  const present = new Set(state.turns.map((turn) => turn.id));
  const waiting: AwaitingDivider[] = [];
  for (const [turnId, { turn, seq }] of state.dividers) {
    if (present.has(turnId)) continue;
    const anchor = turn.prevTurnId;
    if (typeof anchor === "string" && !present.has(anchor)) waiting.push({ turnId, seq });
  }
  return waiting;
}

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

export type Tombstones = ReadonlyMap<string, string>;

export type TurnsWithTombstones = { turns: Turn[]; tombstones: Tombstones };

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

export type ForgottenStamps = ReadonlyMap<string, string>;

export type TurnsWithForgotten = { turns: Turn[]; forgotten: ForgottenStamps };

export function markForgottenIn(
  state: TurnsWithForgotten,
  ids: readonly string[],
  byTurnId: string,
): TurnsWithForgotten {
  let forgotten: Map<string, string> | null = null;
  for (const id of ids) {
    if (state.forgotten.has(id)) continue;
    forgotten ??= new Map(state.forgotten);
    forgotten.set(id, byTurnId);
  }
  const turns = state.turns.map((turn) => {
    const by = (forgotten ?? state.forgotten).get(turn.id);
    return by !== undefined && ids.includes(turn.id) && turn.forgottenBy == null
      ? { ...turn, forgottenBy: by }
      : turn;
  });
  const changed = turns.some((turn, index) => turn !== state.turns[index]);
  if (!changed && !forgotten) return state;
  return { turns: changed ? turns : state.turns, forgotten: forgotten ?? state.forgotten };
}

export function applySnapshotTo(
  fences: { tombstones: Tombstones; dividers: HeldDividers; forgotten?: ForgottenStamps },
  serverTurns: readonly Turn[],
  nextSeq: string,
): { turns: Turn[]; tombstones: Tombstones; dividers: HeldDividers } {
  const { tombstones, dividers, forgotten } = fences;
  const live = new Map([...tombstones].filter(([, seq]) => compareSeq(seq, nextSeq) >= 0));
  const held = new Map([...dividers].filter(([, { seq }]) => compareSeq(seq, nextSeq) >= 0));
  const stamped = forgotten?.size
    ? serverTurns.map((turn) =>
        turn.forgottenBy == null && forgotten.has(turn.id)
          ? { ...turn, forgottenBy: forgotten.get(turn.id) ?? null }
          : turn,
      )
    : serverTurns;
  const kept = live.size ? stamped.filter((turn) => !live.has(turn.id)) : [...stamped];
  const present = new Set(kept.map((turn) => turn.id));
  let turns = kept;
  for (const [id, { turn }] of held)
    if (!present.has(id)) turns = placedAfterAnchor(turns, turn) ?? turns;
  return {
    turns,
    tombstones: live.size === tombstones.size ? tombstones : live,
    dividers: held.size === dividers.size ? dividers : held,
  };
}
