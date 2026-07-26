/**
 * State machine behind editor-to-conversation reveals.
 *
 * The controller is independent of React so the production facade can own one
 * process-wide instance while tests inspect and reset that same instance from
 * test support rather than through production-facing exports.
 */

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
 * and each object is rebuilt only on a stage change so React receives a stable
 * snapshot between transitions.
 */
export type ConversationRevealView = {
  thread: ThreadRevealRequest | null;
  turn: TurnRevealRequest | null;
  change: ChangeRevealRequest | null;
};

type Pending = { id: number; target: ConversationRevealTarget; stage: Stage };
type Listener = () => void;

const IDLE: ConversationRevealView = { thread: null, turn: null, change: null };

type ConversationRevealController = {
  request: (target: ConversationRevealTarget) => void;
  cancel: () => void;
  target: () => ConversationRevealTarget | null;
  subscribe: (listener: Listener) => () => void;
  snapshot: () => ConversationRevealView;
};

function createConversationRevealController(): ConversationRevealController {
  let pending: Pending | null = null;
  let view: ConversationRevealView = IDLE;
  let nextRequestId = 1;
  let backstop: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<Listener>();

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const deeperStage = (stage: Stage, target: Stage): Stage | null => {
    const index = STAGES.indexOf(stage);
    return index < STAGES.indexOf(target) ? STAGES[index + 1] : null;
  };

  const setPending = (next: Pending | null): void => {
    pending = next;
    view = buildView(next);
    if (backstop !== null) clearTimeout(backstop);
    backstop = next
      ? setTimeout(() => settle(next.id, next.stage, "unavailable"), STAGE_BACKSTOP_MS)
      : null;
    for (const listener of listeners) listener();
  };

  const settle = (id: number, stage: Stage, outcome: "landed" | "unavailable"): void => {
    // Reports from a superseded request or an already-settled stage are stale:
    // a child that lands during the same commit its parent reports in would
    // otherwise reopen a finished request.
    if (pending?.id !== id || pending.stage !== stage) return;
    const deeper = outcome === "landed" ? deeperStage(stage, pending.target.kind) : null;
    setPending(deeper === null ? null : { ...pending, stage: deeper });
  };

  const buildView = (next: Pending | null): ConversationRevealView => {
    if (!next) return IDLE;
    const { id, target, stage } = next;
    const landed = () => settle(id, stage, "landed");
    const unavailable = () => settle(id, stage, "unavailable");
    // A stage never runs deeper than its target (see `deeperStage`), so the
    // mismatched arms below are unreachable — they keep union narrowing total.
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
  };

  return {
    request: (target) => setPending({ id: nextRequestId++, target, stage: "thread" }),
    cancel: () => setPending(null),
    target: () => pending?.target ?? null,
    subscribe,
    snapshot: () => view,
  };
}

export const conversationRevealController = createConversationRevealController();
