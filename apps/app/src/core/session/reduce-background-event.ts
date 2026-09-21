/**
 * reduce-background-event — maps the `meridian.background.*` lifecycle CUSTOM
 * events into the parent transcript.
 *
 * A background child's terminal report arrives later as a durable
 * `helper-result` block on its own system turn. Between the `started` event and
 * that report the writer must still see the run, so this reducer synthesizes a
 * running helper-result card on the parent turn — the same custom block the
 * server persists for a foreground spawn — and removes it when the run settles.
 * The card is a custom artifact block, so it renders outside the Thinking fold.
 *
 * The reducer is applied by the persistent durable-projections subscriber (the
 * run-scoped turn reducer also delegates here), so a `completed`/`failed` event
 * that lands after the parent turn ended still clears the card.
 */
import type { AGUIEvent, Block, Turn } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";

import { nextBlockSequence, readString } from "./state-helpers";

const BACKGROUND_STARTED = "meridian.background.started";
const BACKGROUND_COMPLETED = "meridian.background.completed";
const BACKGROUND_FAILED = "meridian.background.failed";

export type BackgroundRunLifecycle =
  | {
      state: "started";
      parentTurnId: string | null;
      childThreadId: string;
      agentSlug: string;
      description: string | null;
    }
  | {
      state: "completed" | "failed";
      parentTurnId: string | null;
      childThreadId: string;
    };

/** The synthetic card's deterministic id, shared by started and settled events. */
export function backgroundRunBlockId(childThreadId: string): string {
  return `background-run:${childThreadId}`;
}

/**
 * Store surface the reducer reads and mutates. Structural subset of
 * ThreadStoreActions so both the live turn reducer and the persistent
 * projections subscriber can apply it.
 */
export type BackgroundRunStore = {
  turns(threadId: string): Turn[] | undefined;
  ensureAssistantTurn(threadId: string, turnId: string, opts?: { createdAt?: string }): void;
  upsertAssistantBlock(threadId: string, turnId: string, block: Block): void;
  removeAssistantBlock(threadId: string, turnId: string, blockId: string): void;
};

export function parseBackgroundRunEvent(event: AGUIEvent): BackgroundRunLifecycle | null {
  if (event.type !== EventType.CUSTOM) return null;
  if (!isBackgroundEventName(event.name)) return null;
  const value = event.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const childThreadId = readString(record.childThreadId);
  if (!childThreadId) return null;

  const parentTurnId = readString(record.parentTurnId) ?? null;

  if (event.name === BACKGROUND_STARTED) {
    const agentSlug = readString(record.agentSlug);
    if (!agentSlug) return null;
    return {
      state: "started",
      parentTurnId,
      childThreadId,
      agentSlug,
      description: readString(record.description) ?? null,
    };
  }

  return {
    state: event.name === BACKGROUND_FAILED ? "failed" : "completed",
    parentTurnId,
    childThreadId,
  };
}

/**
 * Applies one background lifecycle event. Returns true when the event was a
 * background lifecycle event (even if it had nothing to attach to), so callers
 * can stop before the generic opaque-custom fallback.
 */
export function applyBackgroundRunEvent(
  store: BackgroundRunStore,
  threadId: string,
  event: AGUIEvent,
): boolean {
  const isBackground = event.type === EventType.CUSTOM && isBackgroundEventName(event.name);
  if (!isBackground) return false;

  const lifecycle = parseBackgroundRunEvent(event);
  if (!lifecycle) return true;

  if (lifecycle.state === "started") {
    const turnId = resolveParentTurnId(store, threadId, lifecycle.parentTurnId);
    if (!turnId) return true;
    store.ensureAssistantTurn(threadId, turnId, { createdAt: new Date().toISOString() });
    const turn = store.turns(threadId)?.find((candidate) => candidate.id === turnId);
    if (!turn) return true;
    const blockId = backgroundRunBlockId(lifecycle.childThreadId);
    const existing = turn.blocks.find((block) => block.id === blockId) ?? null;
    store.upsertAssistantBlock(threadId, turnId, runningBackgroundBlock(turn, existing, lifecycle));
    return true;
  }

  const located = locateBackgroundBlock(store, threadId, lifecycle.childThreadId);
  if (located) store.removeAssistantBlock(threadId, located.turnId, located.blockId);
  return true;
}

function isBackgroundEventName(name: string): boolean {
  return name === BACKGROUND_STARTED || name === BACKGROUND_COMPLETED || name === BACKGROUND_FAILED;
}

/**
 * Prefer the event's own parent turn; fall back to the active assistant turn,
 * then the last assistant turn, so a started event without `parentTurnId` still
 * lands somewhere visible.
 */
function resolveParentTurnId(
  store: BackgroundRunStore,
  threadId: string,
  parentTurnId: string | null,
): string | null {
  const turns = store.turns(threadId) ?? [];
  if (parentTurnId && turns.some((turn) => turn.id === parentTurnId)) return parentTurnId;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === "assistant" && !isTerminalTurnStatus(turn.status)) return turn.id;
  }
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === "assistant") return turn.id;
  }
  return parentTurnId;
}

function locateBackgroundBlock(
  store: BackgroundRunStore,
  threadId: string,
  childThreadId: string,
): { turnId: string; blockId: string } | null {
  const blockId = backgroundRunBlockId(childThreadId);
  for (const turn of store.turns(threadId) ?? []) {
    if (turn.blocks.some((block) => block.id === blockId)) return { turnId: turn.id, blockId };
  }
  return null;
}

function runningBackgroundBlock(
  turn: Turn,
  existing: Block | null,
  lifecycle: Extract<BackgroundRunLifecycle, { state: "started" }>,
): Block {
  return {
    id: backgroundRunBlockId(lifecycle.childThreadId),
    turnId: turn.id,
    responseId: existing?.responseId ?? null,
    blockType: "custom",
    sequence: existing?.sequence ?? nextBlockSequence(turn.blocks),
    textContent: null,
    content: {
      kind: "helper-result",
      props: {
        agentSlug: lifecycle.agentSlug,
        agentName: helperAgentName(lifecycle.agentSlug),
        status: "running",
        parentTurnId: turn.id,
        childThreadId: lifecycle.childThreadId,
        ...(lifecycle.description ? { title: lifecycle.description } : {}),
      },
    },
    provider: null,
    providerData: null,
    executionSide: "server",
    status: "complete",
    collapsedContent: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Mirrors the server's helper card label (`spawn-output.ts:helperAgentName`) so
 * a live card and its durable report name the same agent. Server lane owns the
 * canonical copy; this stays app-local because the app cannot import server code.
 */
function helperAgentName(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}
