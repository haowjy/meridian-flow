/**
 * Pure turn-list operations behind `TurnStore.ensureAssistantTurn`,
 * `upsertAssistantBlock` and `patchTurnStatus`. Every store (the app's Zustand
 * adapter and `InMemoryTurnStore`) calls these, so the semantics exist once.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { compareSeq } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
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

/** The facts a `meridian.write_mode.switched` frame carries about its divider turn. */
export type SwitchTurnFacts = {
  turnId: string;
  controlId: string;
  mode: AiWriteMode;
  /** The turn the divider follows, null at the head of the chat. */
  prevTurnId: string | null;
  position: number;
};

/** A divider a `switched` frame added, held until a snapshot covers that frame's seq. */
export type HeldDividers = ReadonlyMap<string, { turn: Turn; seq: string }>;

/**
 * The turns with `turn` placed straight after the turn it follows (`prevTurnId`), or at the head
 * when it follows none. Null when the turn it follows is not in `turns`: the place is unknown,
 * and a guess would put the divider where it never was.
 */
function placedAfterAnchor(turns: readonly Turn[], turn: Turn): Turn[] | null {
  if (turn.prevTurnId === null) return [turn, ...turns];
  const at = turns.findIndex((candidate) => candidate.id === turn.prevTurnId);
  if (at < 0) return null;
  return [...turns.slice(0, at + 1), turn, ...turns.slice(at + 1)];
}

/**
 * Adds the write-mode divider a `meridian.write_mode.switched` frame names, as a complete
 * `system` turn carrying the metadata the divider reads, right after the turn the frame says it
 * follows. The frame is the only live announcement of that turn, so this is how a stream
 * follower gets the divider with no snapshot; the stored turn replaces it by id. The divider is
 * also held at the frame's seq: a snapshot read before the switch still lacks it, and
 * `applySnapshotTo` places it again, by the same anchor, until a snapshot covers the frame.
 *
 * When the turn it follows is not in the store yet (another client's message the stream does
 * not carry), the divider is held but not shown: the host's snapshot refresh brings the anchor,
 * and the held divider is placed then. The same state comes back when it is already there.
 */
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

/** A held divider that still waits for the turn it follows, with the seq of the frame that named it. */
export type AwaitingDivider = { turnId: string; seq: string };

/**
 * The held dividers not placed because their anchor is missing from `turns`. A snapshot that
 * covers a divider's frame releases the hold itself (`applySnapshotTo`), present turn or not,
 * so what is listed here is exactly what only a newer snapshot can resolve: the one rule both
 * the app and `./mf` ask before they refresh.
 */
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

/** Turns a `meridian.turns.forgotten` frame named, by id, with the turn that forgot each. Never pruned. */
export type ForgottenStamps = ReadonlyMap<string, string>;

/** A thread's turns with the stamps remembered for them, held or not. */
export type TurnsWithForgotten = { turns: Turn[]; forgotten: ForgottenStamps };

/**
 * Stamps the named turns `forgottenBy` and remembers every id, held or not: a user turn's creation
 * doesn't give the client a row, so a stamp can arrive before the turn is hydrated, and the snapshot that
 * hydrates it applies the remembered stamp. The fact is write-once, so an id already stamped keeps its
 * first forgetting turn. Applying it again changes nothing.
 */
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

/**
 * A server snapshot's turns, less those a removal the snapshot does not cover has taken out, and
 * plus the dividers a frame the snapshot does not cover has added; both fences are the same
 * (`seq < nextSeq` is covered), because a covering snapshot lists the stored turns itself. An older
 * snapshot that lacks a stamp gets the remembered one: forgetting never reverses.
 */
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
  // In frame order, so a divider that follows another is placed after it.
  let turns = kept;
  for (const [id, { turn }] of held)
    if (!present.has(id)) turns = placedAfterAnchor(turns, turn) ?? turns;
  return {
    turns,
    tombstones: live.size === tombstones.size ? tombstones : live,
    dividers: held.size === dividers.size ? dividers : held,
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
