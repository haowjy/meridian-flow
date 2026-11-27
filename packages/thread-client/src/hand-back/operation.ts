import { type FailureEnd, type FailureLog, noFailureLog } from "@meridian/contracts/failures";
import {
  apiThreadHandBackPath,
  apiThreadStopPath,
  handBackResponseSchema,
  stopResponseSchema,
} from "@meridian/contracts/protocol";
import type { HandBackResult, RunState, StopRequest } from "@meridian/contracts/threads";
import {
  type CommandFailure,
  logCommandFailure,
  nextOccurrence,
  type Occurrence,
} from "../commands";
import {
  type FailedStop,
  failedStopIsMoot,
  handBackCandidates,
  stopRequest,
} from "../run-state/fold-messages";
import {
  addIntent,
  answerIntent,
  dropIntent,
  failIntent,
  type RunStateView,
} from "../run-state/run-state-view";
import {
  classifyAnswer,
  type FrozenRequest,
  type HttpPort,
  postFrozen,
  type ResponseSchema,
} from "./classify";

export type HandBackReplay =
  | { kind: "stop"; requestId: string; body: StopRequest }
  | { kind: "queue"; requestId: string; ids: readonly string[] };

export type HandBackCommand = HandBackReplay & { occurrence: Occurrence };

export type HandBackPressInput =
  | { kind: "stop"; view: RunStateView }
  | { kind: "queue"; ids: readonly string[] };

export type RunStatePort = {
  receive(record: RunState): void;
  addIntent(requestId: string, candidates: readonly string[]): void;
  answerIntent(requestId: string, version: string): void;
  failIntent(requestId: string): void;
  dropIntent(requestId: string): void;
};

export type HandBackStore = {
  pending(): readonly HandBackCommand[];
  record(command: HandBackCommand): boolean;
  accept(requestId: string, handedBack: HandBackResult["handedBack"]): boolean;
  drop(requestId: string): boolean;
};

export type HandBackPorts = {
  failureLog?: FailureLog;
  http: HttpPort;
  runState: RunStatePort;
  removeTurns(ids: readonly string[], version: string): void;
  store: HandBackStore;
  newId?: () => string;
};

export type HandBackOutcome =
  | {
      kind: "confirmed";
      command: HandBackCommand;
      result: HandBackResult;
      cancelledExecutionId: string | null;
    }
  | { kind: "refused"; command: HandBackCommand; status: number }
  | { kind: "ambiguous"; command: HandBackCommand; request: FrozenRequest }
  | { kind: "unsaved"; command: HandBackCommand }
  | { kind: "unwritten"; command: HandBackCommand };

export type UnresolvedStatus = "ambiguous" | "unwritten" | "unsaved" | "refused";

export type UnresolvedHandBack = {
  kind?: never;
  requestId: string;
  commandKind: HandBackCommand["kind"];
  status: UnresolvedStatus;
  count: number;
  targetExecutionId: string | null;
  occurrence: Occurrence;
};

export type StopFacts = {
  request: "idle" | "pending";
  cancelledExecutionId: string | null;
  failedStops: readonly FailedStop[];
};

export type HandBackOperation = {
  press(input: HandBackPressInput): Promise<HandBackOutcome>;
  resume(): Promise<HandBackOutcome[]>;
  retry(requestId: string): Promise<HandBackOutcome | null>;
  dismiss(requestId: string): void;
  reconcile(view?: RunStateView): void;
  close(): void;
  open(): void;
  unresolved(): readonly UnresolvedHandBack[];
  stopFacts(): StopFacts;
  subscribe(listener: () => void): () => void;
};

type Held = { command: HandBackCommand; candidates: readonly string[] };
type Entry = Held & { status: UnresolvedStatus; failure: CommandFailure };

const failedStopOf = (e: Held): FailedStop => ({
  targetExecutionId: e.command.kind === "stop" ? e.command.body.seenExecutionId : null,
  candidates: e.candidates.length,
});

const idsOf = (command: HandBackCommand): readonly string[] =>
  command.kind === "queue" ? command.ids : command.body.mine;

function wire(threadId: string, command: HandBackCommand): FrozenRequest {
  return command.kind === "stop"
    ? { path: apiThreadStopPath(threadId), body: command.body }
    : {
        path: apiThreadHandBackPath(threadId),
        body: { requestId: command.requestId, ids: [...command.ids] },
      };
}

type Answer = { result: HandBackResult; runState: RunState; cancelledExecutionId: string | null };

const answerSchemas: Record<HandBackCommand["kind"], ResponseSchema<Answer>> = {
  stop: {
    safeParse(input) {
      const parsed = stopResponseSchema.safeParse(input);
      if (!parsed.success) return { success: false };
      const { handedBack, answered, gone, runState, cancelledExecutionId } = parsed.data;
      return {
        success: true,
        data: { result: { handedBack, answered, gone }, runState, cancelledExecutionId },
      };
    },
  },
  queue: {
    safeParse(input) {
      const parsed = handBackResponseSchema.safeParse(input);
      if (!parsed.success) return { success: false };
      const { handedBack, answered, gone, runState } = parsed.data;
      return {
        success: true,
        data: { result: { handedBack, answered, gone }, runState, cancelledExecutionId: null },
      };
    },
  },
};

export function createHandBackOperation(options: {
  threadId: string;
  ports: HandBackPorts;
}): HandBackOperation {
  const { threadId, ports } = options;
  const { runState, store } = ports;
  const mint = ports.newId ?? (() => globalThis.crypto.randomUUID());
  const entries = new Map<string, Entry>();

  const running = new Map<
    string,
    { kind: HandBackCommand["kind"]; done: Promise<HandBackOutcome> }
  >();
  let cancelledByStop: string | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  const log = ports.failureLog ?? noFailureLog;
  let closed = false;
  let view: RunStateView | undefined;
  const retire = (id: string, end: FailureEnd) => {
    const entry = entries.get(id);
    if (entry) logCommandFailure(log, entry.failure, { threadId }, end);
    entries.delete(id);
  };
  const fail = (held: Held, status: UnresolvedStatus, httpStatus?: number): void => {
    const failure: CommandFailure = {
      ...held.command.occurrence,
      kind: status === "refused" ? "refused" : status === "unsaved" ? "unsaved" : "lost",
      ...(httpStatus === undefined ? {} : { status: httpStatus }),
    };
    logCommandFailure(log, failure, { threadId });
    if (
      closed ||
      (view && held.command.kind === "stop" && failedStopIsMoot(view, failedStopOf(held)))
    ) {
      logCommandFailure(log, failure, { threadId }, "moot");
      return;
    }
    entries.set(held.command.requestId, { ...held, status, failure });
  };

  function attempt(
    held: Held,
    save = true,
    previousStatus?: UnresolvedStatus,
  ): Promise<HandBackOutcome> {
    const requestId = held.command.requestId;
    const joined = running.get(requestId);
    if (joined) return joined.done;
    if (save && !store.record(held.command)) {
      fail(held, previousStatus ?? entries.get(requestId)?.status ?? "unsaved");
      changed();
      return Promise.resolve({ kind: "unsaved", command: held.command });
    }
    if (held.command.kind === "stop") cancelledByStop = null;
    const done = post(held).finally(() => {
      running.delete(requestId);
      changed();
    });
    running.set(requestId, { kind: held.command.kind, done });
    changed();
    return done;
  }

  async function post(held: Held): Promise<HandBackOutcome> {
    const { command, candidates } = held;
    const requestId = command.requestId;
    runState.addIntent(requestId, candidates);
    const request = wire(threadId, command);
    const verdict = classifyAnswer(
      await postFrozen(ports.http, request),
      answerSchemas[command.kind],
    );

    if (verdict.kind === "refused") {
      store.drop(requestId);
      runState.dropIntent(requestId);
      fail(held, "refused", verdict.status);
      return { kind: "refused", command, status: verdict.status };
    }
    if (verdict.kind === "ambiguous") {
      // A remount may confirm the command while this owner posts; drop the intent when its store entry is gone
      if (!store.pending().some((pending) => pending.requestId === requestId)) {
        runState.dropIntent(requestId);
        retire(requestId, "resolved");
        return { kind: "ambiguous", command, request };
      }
      runState.failIntent(requestId);
      fail(held, "ambiguous");
      return { kind: "ambiguous", command, request };
    }

    const { result, runState: record, cancelledExecutionId } = verdict.answer;
    runState.receive(record);
    const taken = [...result.handedBack.map((m) => m.userTurnId), ...result.gone];
    if (taken.length > 0) ports.removeTurns(taken, record.version);
    const written =
      result.handedBack.length > 0
        ? store.accept(requestId, result.handedBack)
        : store.drop(requestId);
    if (result.handedBack.length > 0 && !written) {
      runState.failIntent(requestId);
      fail(held, "unwritten");
      return { kind: "unwritten", command };
    }
    runState.answerIntent(requestId, record.version);
    retire(requestId, "resolved");
    if (command.kind === "stop") cancelledByStop = cancelledExecutionId;
    return { kind: "confirmed", command, result, cancelledExecutionId };
  }

  async function replay(entry: Entry): Promise<HandBackOutcome> {
    const requestId = entry.command.requestId;
    const joined = running.get(requestId);
    if (joined) return joined.done;
    retire(requestId, "retried");
    return attempt(
      {
        ...entry,
        command: {
          ...entry.command,
          occurrence: nextOccurrence(entry.command.occurrence.attempt, mint()),
        },
      },
      true,
      entry.status,
    );
  }

  return {
    async press(input) {
      if (input.kind === "stop") {
        const flying = [...running.values()].find((a) => a.kind === "stop");
        if (flying) return flying.done;
        for (const [id, e] of entries)
          if (e.command.kind === "stop" && failedStopIsMoot(input.view, failedStopOf(e))) {
            retire(id, "moot");
            store.drop(id);
          }
        const owed = [...entries.values()].find(
          (e) => e.command.kind === "stop" && e.status !== "refused",
        );
        if (owed) return replay(owed);
      }
      const requestId = mint();
      const occurrence = nextOccurrence(0, requestId);
      let held: Held;
      if (input.kind === "stop") {
        const body = stopRequest(input.view, requestId);
        held = {
          command: { kind: "stop", requestId, body, occurrence },
          candidates: handBackCandidates(input.view, body),
        };
      } else {
        held = {
          command: { kind: "queue", requestId, ids: [...input.ids], occurrence },
          candidates: [...input.ids],
        };
      }
      const { command } = held;
      for (const [id, entry] of entries)
        if (
          entry.command.kind === command.kind &&
          (entry.status === "refused" || entry.status === "unsaved")
        )
          retire(id, "moved_on");
      return attempt(held);
    },

    async resume() {
      const outcomes: HandBackOutcome[] = [];
      for (const command of store.pending()) {
        if (!store.pending().some((held) => held.requestId === command.requestId)) continue;
        outcomes.push(await attempt({ command, candidates: idsOf(command) }, false));
      }
      return outcomes;
    },

    async retry(requestId) {
      const entry = entries.get(requestId);
      if (!entry || entry.status === "refused") return running.get(requestId)?.done ?? null;
      return replay(entry);
    },

    dismiss(requestId) {
      if (entries.get(requestId)?.status !== "refused") return;
      retire(requestId, "dismissed");
      changed();
    },

    open() {
      closed = false;
    },
    close() {
      closed = true;
      for (const id of entries.keys()) retire(id, "moot");
    },
    reconcile(nextView) {
      if (nextView) view = nextView;
      const stored = new Set(store.pending().map((c) => c.requestId));
      let moved = false;
      for (const [id, entry] of entries) {
        if (view && entry.command.kind === "stop" && failedStopIsMoot(view, failedStopOf(entry))) {
          retire(id, "moot");
          store.drop(id);
          moved = true;
          continue;
        }
        if (entry.status !== "ambiguous" && entry.status !== "unwritten") continue;
        if (!stored.has(id)) {
          retire(id, "resolved");
          moved = true;
        }
      }
      if (moved) changed();
    },

    unresolved() {
      return [...entries.values()].map((e) => ({
        requestId: e.command.requestId,
        commandKind: e.command.kind,
        status: e.status,
        count: e.candidates.length,
        targetExecutionId: e.command.kind === "stop" ? e.command.body.seenExecutionId : null,
        occurrence: e.command.occurrence,
      }));
    },

    stopFacts() {
      const pending = [...running.values()].some((a) => a.kind === "stop");
      return {
        request: pending ? "pending" : "idle",
        cancelledExecutionId: cancelledByStop,
        failedStops: [...entries.values()]
          .filter((e) => e.command.kind === "stop")
          .map(failedStopOf),
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function viewRunStatePort(
  update: (change: (view: RunStateView) => RunStateView) => void,
  receive: (record: RunState) => void,
): RunStatePort {
  return {
    receive,
    addIntent: (requestId, candidates) =>
      update((view) =>
        addIntent(view, {
          kind: "handBack",
          id: requestId,
          candidates,
          failed: false,
          answer: null,
        }),
      ),
    answerIntent: (requestId, version) =>
      update((view) => answerIntent(view, "handBack", requestId, version)),
    failIntent: (requestId) => update((view) => failIntent(view, requestId)),
    dropIntent: (requestId) => update((view) => dropIntent(view, "handBack", requestId)),
  };
}
