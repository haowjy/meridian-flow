import type { PanePlace } from "@/features/project/pane-place";

export type SubagentRevealBlock = "latest" | "card";

export type ConversationRevealTarget = { from?: PanePlace } & (
  | { kind: "thread"; threadId: string }
  | {
      kind: "turn";
      threadId: string;
      turnId: string;
      subagentThreadId?: string;
      subagentBlock?: SubagentRevealBlock;
      toolCallId?: string;
    }
);

const STAGES = ["thread", "turn"] as const;
type Stage = (typeof STAGES)[number];

const STAGE_BACKSTOP_MS = 10_000;

type StageOutcome = {
  landed: () => void;
  unavailable: () => void;
};

export type TurnRevealRequest = StageOutcome & {
  threadId: string;
  turnId: string;
  subagentThreadId?: string;
  subagentBlock?: SubagentRevealBlock;
  toolCallId?: string;
};
type ThreadRevealRequest = { threadId: string; from?: PanePlace; landed: () => void };

export type ConversationRevealView = {
  thread: ThreadRevealRequest | null;
  turn: TurnRevealRequest | null;
};

type Pending = { id: number; target: ConversationRevealTarget; stage: Stage };
type Listener = () => void;

const IDLE: ConversationRevealView = { thread: null, turn: null };

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
    // keep: Ignore reports whose id/stage no longer match pending; a child landing in the same commit its parent reports would otherwise reopen a finished request.
    if (pending?.id !== id || pending.stage !== stage) return;
    const deeper = outcome === "landed" ? deeperStage(stage, pending.target.kind) : null;
    setPending(deeper === null ? null : { ...pending, stage: deeper });
  };

  const buildView = (next: Pending | null): ConversationRevealView => {
    if (!next) return IDLE;
    const { id, target, stage } = next;
    const landed = () => settle(id, stage, "landed");
    const unavailable = () => settle(id, stage, "unavailable");
    switch (stage) {
      case "thread":
        return {
          ...IDLE,
          thread: {
            threadId: target.threadId,
            ...(target.from ? { from: target.from } : {}),
            landed,
          },
        };
      case "turn":
        return target.kind === "thread"
          ? IDLE
          : {
              ...IDLE,
              turn: {
                threadId: target.threadId,
                turnId: target.turnId,
                ...(target.subagentThreadId
                  ? {
                      subagentThreadId: target.subagentThreadId,
                      ...(target.subagentBlock ? { subagentBlock: target.subagentBlock } : {}),
                    }
                  : {}),
                ...(target.toolCallId ? { toolCallId: target.toolCallId } : {}),
                landed,
                unavailable,
              },
            };
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
