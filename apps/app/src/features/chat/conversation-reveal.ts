/**
 * Editor-to-conversation reveal: one request, one owner per stage.
 *
 * A request names how deep to land — a thread, a turn inside it, or a change
 * row inside that turn's receipt — and the surfaces that host those things take
 * it one stage at a time:
 *
 *   thread (shell) → turn (transcript) → change (turn receipt)
 *
 * Exactly one stage is ever in flight, and the surface holding it must report
 * one of two outcomes once its own data settles: `landed` (the writer is
 * looking at it) or `unavailable` (it is not there). An unavailable stage ends
 * the request where its parent left the writer — a change row that never
 * renders still leaves them on its turn, a turn that never arrives still leaves
 * them in the thread. That handoff, not a timer, is what keeps a request from
 * outliving everything that could complete it.
 *
 * The deadline below is only a backstop for the one failure no surface can
 * report: a stage whose surface never mounts at all.
 *
 * Opening a conversation is a REVEAL, never a screen swap: the shell routes a
 * pending request onto whatever surface already hosts the conversation on the
 * writer's current screen (`useConversationRevealRouting`).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

/** Where a reveal asks the writer to land. Each kind names its whole path. */
export type ConversationRevealTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "turn"; threadId: string; turnId: string }
  | { kind: "change"; threadId: string; turnId: string; changeId: string };

/** Stage names ARE target kinds, shallowest first. */
const STAGES = ["thread", "turn", "change"] as const;
type Stage = (typeof STAGES)[number];

/**
 * How long a stage may go without reporting before the request is dropped.
 * Reached only when a stage's surface never mounts (the thread failed to load,
 * the transcript is not on screen), since a mounted surface always reports.
 */
const STAGE_BACKSTOP_MS = 10_000;

type StageOutcome = {
  /** The writer is now looking at this stage's target. */
  landed: () => void;
  /** This stage's data settled and its target is not in it. */
  unavailable: () => void;
};

export type TurnRevealRequest = StageOutcome & { threadId: string; turnId: string };
export type ChangeRevealRequest = StageOutcome & {
  threadId: string;
  turnId: string;
  changeId: string;
};
type ThreadRevealRequest = { threadId: string; landed: () => void };

/**
 * The single in-flight stage, split per owner. At most one field is non-null,
 * and each object is rebuilt only on a stage change so `useSyncExternalStore`
 * sees a stable snapshot between transitions.
 */
type RevealView = {
  thread: ThreadRevealRequest | null;
  turn: TurnRevealRequest | null;
  change: ChangeRevealRequest | null;
};

type Pending = { id: number; target: ConversationRevealTarget; stage: Stage };
type Listener = () => void;

const IDLE: RevealView = { thread: null, turn: null, change: null };

let pending: Pending | null = null;
let view: RevealView = IDLE;
let nextRequestId = 1;
let backstop: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function buildView(next: Pending | null): RevealView {
  if (!next) return IDLE;
  const { id, target, stage } = next;
  const landed = () => settle(id, stage, "landed");
  const unavailable = () => settle(id, stage, "unavailable");
  // A stage never runs deeper than its target (see `deeperStage`), so the
  // mismatched arms below are unreachable — they exist to keep the union
  // narrowing total without a cast.
  switch (stage) {
    case "thread":
      return { ...IDLE, thread: { threadId: target.threadId, landed } };
    case "turn":
      return target.kind === "thread"
        ? IDLE
        : {
            ...IDLE,
            turn: { threadId: target.threadId, turnId: target.turnId, landed, unavailable },
          };
    case "change":
      return target.kind === "change"
        ? {
            ...IDLE,
            change: {
              threadId: target.threadId,
              turnId: target.turnId,
              changeId: target.changeId,
              landed,
              unavailable,
            },
          }
        : IDLE;
  }
}

function setPending(next: Pending | null): void {
  pending = next;
  view = buildView(next);
  if (backstop !== null) clearTimeout(backstop);
  backstop = next
    ? setTimeout(() => settle(next.id, next.stage, "unavailable"), STAGE_BACKSTOP_MS)
    : null;
  for (const listener of listeners) listener();
}

/** The stage below `stage`, or null when `stage` is as deep as `target` goes. */
function deeperStage(stage: Stage, target: Stage): Stage | null {
  const index = STAGES.indexOf(stage);
  return index < STAGES.indexOf(target) ? STAGES[index + 1] : null;
}

function settle(id: number, stage: Stage, outcome: "landed" | "unavailable"): void {
  // Reports from a superseded request or an already-settled stage are stale:
  // a child that lands during the same commit its parent reports in would
  // otherwise reopen a finished request.
  if (pending?.id !== id || pending.stage !== stage) return;
  const deeper = outcome === "landed" ? deeperStage(stage, pending.target.kind) : null;
  setPending(deeper === null ? null : { ...pending, stage: deeper });
}

export function requestConversationReveal(target: ConversationRevealTarget): void {
  setPending({ id: nextRequestId++, target, stage: "thread" });
}

/** Drops the in-flight request without landing it. */
export function abandonConversationReveal(): void {
  setPending(null);
}

/** The target in flight — for diagnostics and assertions, never for rendering. */
export function peekConversationReveal(): ConversationRevealTarget | null {
  return pending?.target ?? null;
}

function useRevealStage<T>(select: (view: RevealView) => T | null): T | null {
  return useSyncExternalStore(
    subscribe,
    () => select(view),
    () => null,
  );
}

/**
 * Binds the thread stage to the shell that owns conversation surfaces.
 *
 * `revealConversation` must bring the named conversation into view WITHOUT
 * leaving the current screen wherever a surface can host it; only shells with
 * no such surface (the phone, which shows one view at a time) may navigate.
 * The shell always lands: pointing a surface at a thread cannot fail, so this
 * stage has no `unavailable`.
 */
export function useConversationRevealRouting(revealConversation: (threadId: string) => void): void {
  const request = useRevealStage((current) => current.thread);
  const reveal = useRef(revealConversation);
  reveal.current = revealConversation;

  useEffect(() => {
    if (!request) return;
    reveal.current(request.threadId);
    request.landed();
  }, [request]);
}

/** The turn this thread's transcript must land on, or null when none is owed. */
export function useTurnReveal(threadId: string): TurnRevealRequest | null {
  return useRevealStage((current) => (current.turn?.threadId === threadId ? current.turn : null));
}

/** The change row this turn's receipt must bring into view, or null. */
export function useChangeReveal(threadId: string, turnId: string): ChangeRevealRequest | null {
  return useRevealStage((current) =>
    current.change?.threadId === threadId && current.change.turnId === turnId
      ? current.change
      : null,
  );
}
