/**
 * The hand-back operation: Stop, the queue's x and Cancel queue, run once for the app and `./mf`.
 * Framework-free, over explicit ports; the clients contribute adapters (storage, editor, printing).
 *
 * Order of a press: save the command, add the intent (rows hide at once), post, classify the answer
 * (nothing changes until the whole record validated), then on a confirmed answer receive the record,
 * remove turns at its version, write the content once (`store.accept`), and answer the intent. A lost
 * race (`answered`, nothing handed back) writes nothing. It is not a general mutation framework.
 */
import {
  apiThreadHandBackPath,
  apiThreadStopPath,
  handBackResponseSchema,
  stopResponseSchema,
} from "@meridian/contracts/protocol";
import type { HandBackResult, RunState, StopRequest } from "@meridian/contracts/threads";
import { handBackCandidates, stopRequest } from "../run-state/fold-messages";
import {
  addIntent,
  answerIntent,
  dropIntent,
  type RunStateView,
} from "../run-state/run-state-view";
import {
  classifyAnswer,
  type FrozenRequest,
  type HttpPort,
  postFrozen,
  type ResponseSchema,
} from "./classify";

/** What the operation posts and persists. `stop` keeps Stop's stored format. */
export type HandBackCommand =
  | { kind: "stop"; requestId: string; body: StopRequest }
  | { kind: "queue"; requestId: string; ids: readonly string[] };

/** A press: Stop over the view the writer saw, or the x / Cancel queue over the ids drawn as queued. */
export type HandBackPressInput =
  | { kind: "stop"; view: RunStateView }
  | { kind: "queue"; ids: readonly string[] };

/** The record and the intents, narrowed to what the operation may do. L1's session implements it. */
export type RunStatePort = {
  /** Receive a command answer's whole record through the host's one version check. */
  receive(record: RunState): void;
  /** Hide `candidates` while the request is in flight. */
  addIntent(requestId: string, candidates: readonly string[]): void;
  /** The server answered at `version`: the intent retires once the held record reaches it. */
  answerIntent(requestId: string, version: string): void;
  /** The last attempt did not succeed: the rows show again. */
  failIntent(requestId: string): void;
  dropIntent(requestId: string): void;
};

/**
 * The pending-command store (the app: the composer draft in `sessionStorage`). Every write answers
 * whether it took.
 */
export type HandBackStore = {
  pending(): readonly HandBackCommand[];
  record(command: HandBackCommand): boolean;
  /** The content already arrived for this command, so a resume must not post it again. */
  received(requestId: string): boolean;
  /** The content, the receipt and the command's retirement in one checked write. */
  accept(requestId: string, handedBack: HandBackResult["handedBack"]): boolean;
  drop(requestId: string): boolean;
};

export type HandBackPorts = {
  http: HttpPort;
  runState: RunStatePort;
  /** Remove turns another request took, at the record's version (the turn store's tombstone fence). */
  removeTurns(ids: readonly string[], version: string): void;
  store: HandBackStore;
  /** Mints request ids. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
};

export type HandBackOutcome =
  | {
      kind: "confirmed";
      command: HandBackCommand;
      result: HandBackResult;
      /** Stop only: the execution the press cancelled. */
      cancelledExecutionId: string | null;
    }
  /** A definite 4xx. The command and the intent are dropped. */
  | { kind: "refused"; command: HandBackCommand; status: number }
  /** The server may have acted. The command is kept; `request` replays it exactly. */
  | { kind: "ambiguous"; command: HandBackCommand; request: FrozenRequest }
  /** The store refused the command: nothing was sent. */
  | { kind: "unsaved"; command: HandBackCommand }
  /** Confirmed, but the content could not be written. The command is kept; a replay brings it again. */
  | { kind: "unwritten"; command: HandBackCommand };

export type UnresolvedStatus = "ambiguous" | "unwritten" | "unsaved" | "refused";

/** A command that still owes the writer something. */
export type UnresolvedHandBack = {
  kind?: never;
  requestId: string;
  commandKind: HandBackCommand["kind"];
  status: UnresolvedStatus;
  /** How many messages the press covered. */
  count: number;
};

export type HandBackOperation = {
  press(input: HandBackPressInput): Promise<HandBackOutcome>;
  /** Re-post every stored command, dropping one whose content already arrived. */
  resume(): Promise<HandBackOutcome[]>;
  /** Replay one unresolved command that is held (not `refused`): the card's Try again. */
  retry(requestId: string): Promise<HandBackOutcome | null>;
  /** Forget a `refused` entry: the card's Dismiss. */
  dismiss(requestId: string): void;
  /**
   * Called by the host when the store may have changed under the operation (another tab, a
   * reload): entries whose command left the store, or whose content arrived, stop owing a card.
   */
  reconcile(): void;
  unresolved(): readonly UnresolvedHandBack[];
};

type Held = { command: HandBackCommand; candidates: readonly string[] };
type Entry = Held & { status: UnresolvedStatus };

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
  /** Every command that owes a card. Commands in the store are also here; page-memory ones only here. */
  const entries = new Map<string, Entry>();

  const fail = (held: Held, status: UnresolvedStatus): Entry => {
    const entry = { ...held, status };
    entries.set(held.command.requestId, entry);
    return entry;
  };

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
      fail(held, "refused");
      return { kind: "refused", command, status: verdict.status };
    }
    if (verdict.kind === "ambiguous") {
      runState.failIntent(requestId);
      fail(held, "ambiguous");
      return { kind: "ambiguous", command, request };
    }

    const { result, runState: record, cancelledExecutionId } = verdict.answer;
    runState.receive(record);
    const taken = [...result.handedBack.map((m) => m.userTurnId), ...result.gone];
    if (taken.length > 0) ports.removeTurns(taken, record.version);
    // A lost race hands nothing back: write nothing, and the row comes back as an ordinary message.
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
    entries.delete(requestId);
    return { kind: "confirmed", command, result, cancelledExecutionId };
  }

  return {
    async press(input) {
      const requestId = mint();
      let held: Held;
      if (input.kind === "stop") {
        const body = stopRequest(input.view, requestId);
        held = {
          command: { kind: "stop", requestId, body },
          candidates: handBackCandidates(input.view, {
            kind: "seen",
            seenThrough: body.seenThrough,
            mine: body.mine,
          }),
        };
      } else {
        held = {
          command: { kind: "queue", requestId, ids: [...input.ids] },
          candidates: [...input.ids],
        };
      }
      const { command } = held;
      // A new press replaces a page-memory entry of its kind; a stored one still holds words.
      for (const [id, entry] of entries)
        if (
          entry.command.kind === command.kind &&
          (entry.status === "refused" || entry.status === "unsaved")
        )
          entries.delete(id);
      if (!store.record(command)) {
        fail(held, "unsaved");
        return { kind: "unsaved", command };
      }
      return post(held);
    },

    async resume() {
      const outcomes: HandBackOutcome[] = [];
      for (const command of store.pending()) {
        if (store.received(command.requestId)) {
          store.drop(command.requestId);
          entries.delete(command.requestId);
          continue;
        }
        outcomes.push(await post({ command, candidates: idsOf(command) }));
      }
      return outcomes;
    },

    async retry(requestId) {
      const entry = entries.get(requestId);
      if (!entry || entry.status === "refused") return null;
      if (entry.status === "unsaved") {
        if (!store.record(entry.command)) return { kind: "unsaved", command: entry.command };
      }
      return post(entry);
    },

    dismiss(requestId) {
      if (entries.get(requestId)?.status === "refused") entries.delete(requestId);
    },

    reconcile() {
      const stored = new Set(store.pending().map((c) => c.requestId));
      for (const [id, entry] of entries) {
        if (entry.status !== "ambiguous" && entry.status !== "unwritten") continue;
        if (!stored.has(id)) entries.delete(id);
        else if (store.received(id)) {
          store.drop(id);
          entries.delete(id);
        }
      }
    },

    unresolved() {
      return [...entries.values()].map((e) => ({
        requestId: e.command.requestId,
        commandKind: e.command.kind,
        status: e.status,
        count: Math.max(1, e.candidates.length),
      }));
    },
  };
}

/**
 * A `RunStatePort` over a view the host holds (the app's store slice, `./mf`'s local view). The
 * intent shape is the operation's: a `handBack` intent. `update` applies a pure view transition.
 */
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
    failIntent: (requestId) =>
      update((view) => ({
        ...view,
        intents: view.intents.map((intent) =>
          intent.kind === "handBack" && intent.id === requestId
            ? { ...intent, failed: true }
            : intent,
        ),
      })),
    dropIntent: (requestId) => update((view) => dropIntent(view, "handBack", requestId)),
  };
}
