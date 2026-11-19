/** One review item's ordered Apply, Un-Apply, and Redo command schedule. */
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
  ApplyClickResult,
  RedoClick,
  UnapplyClick,
  UnapplyClickAnswer,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import type { Node as PMNode } from "@tiptap/pm/model";
import { itemLanded, itemOf, textUndoneOf } from "./draft-notices";

export type FrozenApply = {
  body: ApplyClick;
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  /**
   * Settles once the room can deliver no more of the typing in the click's cut: resolved when the
   * server has it, so the frozen click goes; rejected when the room ended first, so it is rebuilt.
   */
  acknowledged: Promise<void>;
  /** Made after its room ended: it is rebuilt before it is sent. */
  madeAfterRoomEnded?: true;
  /**
   * The click again, from the draft as the server holds it when this click is the head: what to
   * send, null when none of its changes is there, undefined to send it as it is, "reload" when
   * this build can't read the draft, so the server can't take the click either. Rejects when
   * `signal` aborts: the read was not answered in time, or the queue closed.
   */
  rebuild?: (
    signal: AbortSignal,
  ) => Promise<Pick<FrozenApply, "body" | "optimistic" | "patched"> | null | "reload" | undefined>;
  /** A member of a several-item Apply sends through its group (`GroupApply`), not on its own. */
  send?: (body: ApplyClick) => Promise<ApplyClickAnswer>;
};

/** Whether `answer` says this item's text cut landed: text that never landed has nothing to fold. */
function textLanded(answer: ApplyClickResult, node: string): boolean {
  return itemOf(answer, node)?.text?.landed === true;
}

/** A click frozen on `draftId`'s room: the room folds it into its base until it records it. */
export function frozenOn(command: { body: ApplyClick }, draftId: string): boolean {
  return command.body.snapshot !== undefined && command.body.draftId === draftId;
}

export type ApplyClickLanded = { status: "landed"; commandId: string };
/** The click never reached the server: this build can't read its draft (`rebuild` said "reload"), or its id is another command's. */
export type ClickUnsent = { status: "unsent"; commandId: string };
export type ApplyClickOutcome =
  | ApplyClickResult
  | ApplyClickLanded
  | ClickUnsent
  | { status: "cancelled" };
export type UnapplyClickOutcome = UnapplyClickResult | ClickUnsent | { status: "cancelled" };

type ApplyCommand = FrozenApply & {
  kind: "apply";
  sent: boolean;
  attempts: number;
  stalled: boolean;
  closed: boolean;
  /** Its `acknowledged` settled: it may be sent once it is the head. */
  released: boolean;
  /** Its room ended: no record of it will show, so its applied answer settles it. */
  roomEnded: boolean;
  /** Its room ended before the server had its typing: `rebuild` runs before it is sent. */
  rebuilding: boolean;
  answer?: ApplyClickResult;
  inFlight?: boolean;
  reading?: boolean;
  outcome: Promise<ApplyClickOutcome>;
  finish(result: ApplyClickOutcome): void;
};
export type UnapplyCommand = {
  kind: "unapply";
  body: UnapplyClick;
  draftId: string;
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  patchFor(groupIds: readonly string[]): readonly PMNode[];
  /** What the answer took back. */
  selectionChanged(groupIds: readonly string[], tree: boolean): void;
  ready: Promise<boolean>;
  groupIds: Set<string>;
  sent: boolean;
  attempts: number;
  stalled: boolean;
  answer?: UnapplyClickResult;
  /** The server's answer as it arrives, or how the command ended without one. */
  heard: Promise<UnapplyClickOutcome>;
  hear(result: UnapplyClickOutcome): void;
  outcome: Promise<UnapplyClickOutcome>;
  finish(result: UnapplyClickOutcome): void;
};
type Command = ApplyCommand | UnapplyCommand;

export type ApplyCommandHandle = {
  /**
   * The Un-Apply's answer as soon as the server gives it, while its rows may still be leaving the
   * room; `unsent` when it was refused and the Apply stands, `cancelled` when the Apply was never
   * sent.
   */
  undo(): Promise<UnapplyClickOutcome>;
  /** Queues the Redo at once; resolves with what became of it. */
  redo(): Promise<ApplyClickOutcome>;
  /** The Apply in force: its command id, which a Redo replaces only once it lands. */
  applyInForce(): string;
};
type ScheduledApplyHandle = ApplyCommandHandle & {
  /** The latest Apply queued: the one an Un-Apply names, or cancels before it is sent. */
  current: ApplyCommand;
  /** The Apply in force: the first, or the latest Redo that landed. */
  inForce: ApplyCommand;
  reversal: Promise<UnapplyClickOutcome>;
  replaySelection: string[];
  /** The Un-Apply took this item's tree change back, so the Redo's painting shows it. */
  replayTree: boolean;
  /** The Un-Apply sent, which the Redo names; null when it was cancelled before it was sent. */
  unapplyId: string | null;
  pendingReplay: ApplyCommand | null;
};

export const APPLY_FEEDBACK_MS = 500;
const RETRY_DELAYS = [1000, 2000, 4000];
/** As long as a send waits for its answer (`branches-api.ts`), so a rebuild stalls as a send does. */
const REBUILD_TIMEOUT_MS = 10_000;

export class ApplyClickQueue {
  private readonly commands: Command[] = [];
  private readonly recorded = new Map<string, Set<string>>();
  private readonly recordedRows = new Map<string, { commandId: string; groupId?: string }[]>();
  private readonly resolving = new Set<ApplyCommand>();
  /**
   * Clicks whose room ended before it recorded them, by draft: the server applied them, so the
   * projection keeps folding them until a room opens again on the draft as the server holds it.
   */
  private readonly landedUnrecorded = new Map<string, ApplyCommand[]>();
  /** The read a rebuilding head waits on, stopped when the queue closes. */
  private rebuildRead: AbortController | null = null;
  private closed = false;
  private request: Command | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  applying = false;

  constructor(
    private readonly port: {
      /** The item's node: an Apply's answer is read from its entry, whatever its siblings did. */
      node: string;
      send(body: ApplyClick): Promise<ApplyClickAnswer>;
      lookup(body: ApplyClick): Promise<ApplyClickObservation>;
      unapply?(body: UnapplyClick): Promise<UnapplyClickAnswer>;
      redo?(body: RedoClick): Promise<ApplyClickAnswer>;
      changed(): void;
    },
  ) {}

  get clicks(): ApplyCommand[] {
    return this.commands.filter((command): command is ApplyCommand => command.kind === "apply");
  }

  get unapplies(): UnapplyCommand[] {
    return this.commands.filter((command): command is UnapplyCommand => command.kind === "unapply");
  }

  get stalled(): boolean {
    return this.commands[0]?.stalled ?? false;
  }

  get pending(): boolean {
    return this.commands.length > 0;
  }

  enqueue(frozen: FrozenApply): Promise<ApplyClickOutcome> {
    if (this.closed) return Promise.resolve({ status: "cancelled" });
    const result = this.queueApply(frozen).outcome;
    this.startFeedback();
    this.port.changed();
    return result;
  }

  /** Own one Apply's command identity, reversal result, and replay selection. */
  enqueueHistory(input: {
    frozen: FrozenApply;
    patchFor(groupIds: readonly string[]): readonly PMNode[];
    intent(): void;
    /** A Redo's answer, landed or not: its item shows what of it stayed out. */
    replayed(answer: ApplyClickOutcome): void;
  }): { outcome: Promise<ApplyClickOutcome>; handle: ApplyCommandHandle } {
    const initial = this.queueApply(input.frozen);
    this.startFeedback();
    this.port.changed();
    // Either half landing gives the Apply something to take back; a Redo replays text alone.
    const landed = (answer: ApplyClickOutcome) => {
      if (answer.status === "landed") return true;
      return answer.status === "applied" && itemLanded(answer, this.port.node);
    };
    let handle!: ScheduledApplyHandle;
    handle = {
      current: initial,
      inForce: initial,
      reversal: Promise.resolve({ status: "cancelled" }),
      replaySelection: [...initial.body.groupIds],
      replayTree: initial.body.tree === true,
      unapplyId: null,
      pendingReplay: null,
      undo: () => {
        input.intent();
        handle.pendingReplay = null;
        if (this.cancel(handle.current.body.commandId)) {
          handle.unapplyId = null;
          handle.reversal = Promise.resolve({ status: "cancelled" });
          return handle.reversal;
        }
        handle.replaySelection = [...handle.current.body.groupIds];
        handle.replayTree = handle.current.body.tree === true;
        const unapplyId = crypto.randomUUID();
        handle.unapplyId = unapplyId;
        const inverse = this.queueUnapply({
          body: {
            commandId: unapplyId,
            applyCommandId: handle.current.body.commandId,
          },
          draftId: handle.current.body.draftId ?? "",
          optimistic: handle.current.optimistic,
          patched: handle.current.patched,
          groupIds: handle.current.body.groupIds,
          patchFor: input.patchFor,
          ready: handle.current.outcome.then((answer) => {
            // Text that never landed has nothing to fold back while the Un-Apply is out.
            if (answer.status === "applied" && !textLanded(answer, this.port.node)) {
              inverse.groupIds.clear();
              inverse.patched = inverse.optimistic;
            }
            return landed(answer);
          }),
          // A Redo pressed before the answer brings back only what the Un-Apply took back, and
          // nothing when it took nothing.
          selectionChanged: (groupIds, tree) => {
            handle.replaySelection = [...groupIds];
            handle.replayTree = tree;
            const replay = handle.pendingReplay;
            if (!replay || replay.sent) return;
            if (groupIds.length === 0 && !tree) {
              handle.pendingReplay = null;
              this.cancel(replay.body.commandId);
              return;
            }
            replay.body = { ...replay.body, groupIds: [...groupIds], tree: tree || undefined };
            replay.patched = input.patchFor(groupIds);
          },
        });
        handle.reversal = inverse.outcome;
        return inverse.heard;
      },
      redo: () => {
        input.intent();
        const before = handle.inForce;
        const { unapplyId } = handle;
        const sendRedo = this.port.redo?.bind(this.port);
        const replay = this.queueApply({
          // What the review shows at once and records under its id. The Redo sent names only the
          // Un-Apply: the server works out what it took back. An Apply cancelled before it was
          // sent has no Un-Apply: the click goes again as it was frozen.
          body: {
            ...handle.current.body,
            commandId: crypto.randomUUID(),
            groupIds: [...handle.replaySelection],
            tree: handle.replayTree || undefined,
          },
          ...(unapplyId && sendRedo
            ? { send: (body) => sendRedo({ commandId: body.commandId, redoOf: unapplyId }) }
            : {}),
          optimistic: handle.current.optimistic,
          patched: input.patchFor(handle.replaySelection),
          // Waits for the Un-Apply: one that did not land leaves the Apply standing, so the Redo
          // has nothing to do and is cancelled before it is sent.
          acknowledged: handle.reversal.then((answer) => {
            if (answer.status !== "cancelled" && answer.status !== "unapplied")
              this.cancel(replay.body.commandId);
          }),
        });
        handle.current = replay;
        handle.pendingReplay = replay;
        this.startFeedback();
        this.port.changed();
        return replay.outcome.then((answer) => {
          if (landed(answer)) handle.inForce = replay;
          // A replay that never reached the server leaves the Apply it would have replaced as the
          // one in force, the one the next Un-Apply names.
          else if (
            (answer.status === "cancelled" || answer.status === "unsent") &&
            handle.current === replay
          )
            handle.current = before;
          if (answer.status !== "cancelled") input.replayed(answer);
          return answer;
        });
      },
      applyInForce: () => handle.inForce.body.commandId,
    };

    return {
      outcome: initial.outcome,
      handle,
    };
  }

  /** Fold unresolved writer intents in the same order in which they are delivered. */
  project(
    draftId: string,
    base: readonly PMNode[],
    fold: (
      base: readonly PMNode[],
      before: readonly PMNode[],
      after: readonly PMNode[],
    ) => readonly PMNode[],
  ): readonly PMNode[] {
    let projected = base;
    for (const command of this.landedUnrecorded.get(draftId) ?? [])
      projected = fold(projected, command.optimistic, command.patched);
    for (const command of this.commands) {
      if (command.kind === "apply") {
        if (frozenOn(command, draftId) && !this.isRecorded(command))
          projected = fold(projected, command.optimistic, command.patched);
      } else if (command.draftId === draftId) {
        projected = fold(projected, command.patched, command.optimistic);
      }
    }
    return projected;
  }

  private queueApply(frozen: FrozenApply): ApplyCommand {
    let finish!: (result: ApplyClickOutcome) => void;
    const outcome = new Promise<ApplyClickOutcome>((resolve) => {
      finish = resolve;
    });
    const command: ApplyCommand = {
      kind: "apply",
      ...frozen,
      sent: false,
      attempts: 0,
      stalled: false,
      closed: false,
      released: false,
      roomEnded: frozen.madeAfterRoomEnded === true,
      rebuilding: frozen.madeAfterRoomEnded === true,
      outcome,
      finish,
    };
    this.commands.push(command);
    // A room that ended delivers nothing more: the click goes anyway, rebuilt.
    const go = (ended: boolean) => {
      if (!this.commands.includes(command)) return;
      command.released = true;
      command.rebuilding ||= ended;
      if (this.commands[0] === command) void this.dispatch(command);
    };
    void frozen.acknowledged.then(
      () => go(false),
      () => go(true),
    );
    return command;
  }

  private queueUnapply(input: {
    body: UnapplyClick;
    draftId: string;
    optimistic: readonly PMNode[];
    patched: readonly PMNode[];
    groupIds: readonly string[];
    patchFor(groupIds: readonly string[]): readonly PMNode[];
    selectionChanged(groupIds: readonly string[], tree: boolean): void;
    ready: Promise<boolean>;
  }): UnapplyCommand {
    let finish!: (result: UnapplyClickOutcome) => void;
    let hear!: (result: UnapplyClickOutcome) => void;
    const outcome = new Promise<UnapplyClickOutcome>((resolve) => {
      finish = resolve;
    });
    const heard = new Promise<UnapplyClickOutcome>((resolve) => {
      hear = resolve;
    });
    const command: UnapplyCommand = {
      kind: "unapply",
      ...input,
      groupIds: new Set(input.groupIds),
      sent: false,
      attempts: 0,
      stalled: false,
      heard,
      hear,
      outcome,
      finish: (result) => {
        hear(result);
        finish(result);
      },
    };
    this.commands.push(command);
    this.port.changed();
    this.moveOn();
    return command;
  }

  observe(draftId: string, rows: Iterable<string | { commandId: string; groupId?: string }>): void {
    const records = [...rows].map((row) => (typeof row === "string" ? { commandId: row } : row));
    this.recordedRows.set(draftId, records);
    this.recorded.set(draftId, new Set(records.map((row) => row.commandId)));
    const head = this.commands[0];
    if (head?.kind === "apply" && this.isRecorded(head)) {
      this.release(head);
      this.completeApply(head);
    } else if (head?.kind === "unapply") {
      this.reconcileUnapply(head, records);
    } else this.port.changed();
  }

  retry(): void {
    const head = this.commands[0];
    if (!head?.stalled) return;
    head.stalled = false;
    head.attempts = 0;
    this.port.changed();
    void this.dispatch(head);
  }

  cancel(commandId: string): boolean {
    const command = this.commands.find(
      (candidate): candidate is ApplyCommand =>
        candidate.kind === "apply" && candidate.body.commandId === commandId,
    );
    if (!command || command.sent) return false;
    this.commands.splice(this.commands.indexOf(command), 1);
    command.finish({ status: "cancelled" });
    this.moveOn();
    return true;
  }

  /**
   * The draft's room ended, so it records nothing more: an applied answer settles without the
   * record. Its clicks still go (`acknowledged` says which are rebuilt).
   */
  roomEnded(draftId: string): void {
    for (const command of this.clicks) if (frozenOn(command, draftId)) command.roomEnded = true;
    const head = this.commands[0];
    if (head?.kind === "apply" && head.roomEnded && head.answer?.status === "applied")
      this.settle(head, head.answer);
    else this.port.changed();
  }

  /** A room opened on the draft as the server holds it: what it applied without a record is there. */
  roomOpened(draftId: string): void {
    if (this.landedUnrecorded.delete(draftId)) this.port.changed();
  }

  close(draftId?: string): void {
    if (this.closed) return;
    const head = this.commands[0];
    if (
      this.rebuildRead &&
      head?.kind === "apply" &&
      (draftId === undefined || head.body.draftId === draftId)
    )
      this.rebuildRead.abort();
    if (draftId === undefined) {
      this.closed = true;
      clearTimeout(this.retryTimer);
    }
    const closing = this.clicks.filter(
      (command) => !command.closed && (draftId === undefined || command.body.draftId === draftId),
    );
    for (const command of closing) {
      command.closed = true;
      if (command === head && command.sent) continue;
      this.commands.splice(this.commands.indexOf(command), 1);
      command.finish({ status: "cancelled" });
    }
    if (head?.kind === "apply" && head.sent && closing.includes(head)) {
      if (head.answer?.status === "applied") this.settle(head, head.answer);
      else if (!this.request) void this.lookupClosed(head);
    }
    this.moveOn();
  }

  destroy(): void {
    this.rebuildRead?.abort();
    clearTimeout(this.retryTimer);
    clearTimeout(this.feedbackTimer);
    for (const command of this.commands.splice(0))
      command.finish(command.kind === "apply" ? { status: "cancelled" } : { status: "cancelled" });
    for (const click of this.resolving)
      click.finish({ status: "landed", commandId: click.body.commandId });
    this.resolving.clear();
  }

  private startFeedback(): void {
    if (this.feedbackTimer) return;
    this.feedbackTimer = setTimeout(() => {
      this.applying = this.clicks.length > 0;
      this.port.changed();
    }, APPLY_FEEDBACK_MS);
  }

  private isRecorded(command: ApplyCommand): boolean {
    const { draftId, commandId } = command.body;
    return draftId !== undefined && (this.recorded.get(draftId)?.has(commandId) ?? false);
  }

  private moveOn(): void {
    this.clearFeedbackIfIdle();
    this.port.changed();
    const next = this.commands[0];
    if (next && !this.request && !next.sent && !this.closed) void this.dispatch(next);
  }

  private async dispatch(command: Command): Promise<void> {
    if (this.request || this.commands[0] !== command || command.stalled) return;
    if (command.kind === "apply") await this.dispatchApply(command);
    else await this.dispatchUnapply(command);
  }

  private async dispatchApply(command: ApplyCommand): Promise<void> {
    if (!command.released) return;
    if (command.rebuilding && command.rebuild) {
      // Holds the line: nothing is sent around a head that is being rebuilt.
      this.request = command;
      const read = new AbortController();
      this.rebuildRead = read;
      const timeout = setTimeout(() => read.abort(), REBUILD_TIMEOUT_MS);
      let rebuilt: Awaited<ReturnType<NonNullable<FrozenApply["rebuild"]>>>;
      let answered = true;
      try {
        rebuilt = await command.rebuild(read.signal);
      } catch (cause) {
        if (!read.signal.aborted) reportError(cause);
        answered = false;
      }
      clearTimeout(timeout);
      this.rebuildRead = null;
      if (this.request === command) this.request = null;
      if (this.commands[0] !== command) {
        this.moveOn();
        return;
      }
      // Unanswered, like a send: tried again, then stalled with Retry.
      if (!answered) {
        this.scheduleRetry(command);
        return;
      }
      command.rebuilding = false;
      if (rebuilt === null) {
        this.settle(command, { status: "cancelled" });
        return;
      }
      if (rebuilt === "reload") {
        this.settle(command, { status: "unsent", commandId: command.body.commandId });
        return;
      }
      if (rebuilt) Object.assign(command, rebuilt);
    }
    this.request = command;
    command.sent = true;
    command.inFlight = true;
    let answer: ApplyClickObservation | undefined;
    try {
      answer = await (command.closed
        ? this.port.lookup(command.body)
        : (command.send ?? this.port.send)(command.body));
    } catch {
      // Unknown delivery retains this immutable head.
    }
    command.inFlight = false;
    if (this.request === command) this.request = null;
    if (answer?.commandId !== command.body.commandId) answer = undefined;
    if (answer?.status === "applied") command.answer = answer;
    if (this.commands[0] !== command) {
      if (this.resolving.has(command)) this.completeApply(command);
      this.moveOn();
      return;
    }
    if (answer?.status === "applied") {
      // An Apply record in the room is the proof this item's text cut landed: with none written
      // (its text came back settled, or there was none) the answer is final, whatever a sibling
      // in the same command landed. A frozen click settles once its room records it; one cut on
      // receipt has no room to, nor has one whose room ended.
      if (
        !command.body.snapshot ||
        command.closed ||
        command.roomEnded ||
        !textLanded(answer, this.port.node) ||
        this.isRecorded(command)
      )
        this.settle(command, answer);
      return;
    }
    // The id is the server's for another command: resending it can only answer the same. A
    // closed head reads its durable outcome instead, below.
    if (answer?.status === "conflict" && !command.closed) {
      this.settle(command, { status: "unsent", commandId: answer.commandId });
      return;
    }
    if (command.closed && answer?.status === "none") {
      this.settle(command, { status: "cancelled" });
      return;
    }
    if (command.closed && !answer) {
      void this.lookupClosed(command);
      return;
    }
    this.scheduleRetry(command);
  }

  private async dispatchUnapply(command: UnapplyCommand): Promise<void> {
    if (!(await command.ready)) {
      if (this.commands[0] === command) this.settle(command, { status: "cancelled" });
      return;
    }
    if (this.request || this.commands[0] !== command || command.stalled) return;
    this.request = command;
    command.sent = true;
    let answer: UnapplyClickAnswer | undefined;
    try {
      answer = await this.port.unapply?.(command.body);
    } catch {
      // Unknown delivery retains the projection, command identity, and later commands.
    }
    if (this.request === command) this.request = null;
    if (answer?.commandId !== command.body.commandId) answer = undefined;
    if (this.commands[0] !== command) return;
    if (answer?.status === "unapplied") {
      command.answer = answer;
      const undone = textUndoneOf(answer, this.port.node);
      command.groupIds = new Set(undone);
      command.patched = command.patchFor(undone);
      command.selectionChanged(undone, answer.treeUndone.includes(this.port.node));
      // The answer is acted on now (notice, history, hand-over); the room only settles it.
      command.hear(answer);
      this.reconcileUnapply(command);
      return;
    }
    if (answer?.status === "conflict") {
      this.settle(command, { status: "unsent", commandId: answer.commandId });
      return;
    }
    this.scheduleRetry(command);
  }

  private reconcileUnapply(
    command: UnapplyCommand,
    observed = this.currentRecords(command.draftId),
  ): void {
    const answer = command.answer;
    if (!answer) {
      this.port.changed();
      return;
    }
    const remaining = observed.some(
      (row) =>
        row.commandId === command.body.applyCommandId && command.groupIds.has(row.groupId ?? ""),
    );
    if (!remaining) this.settle(command, answer);
    else this.port.changed();
  }

  private currentRecords(draftId: string): { commandId: string; groupId?: string }[] {
    return this.recordedRows.get(draftId) ?? [];
  }

  private async lookupClosed(command: ApplyCommand): Promise<void> {
    try {
      const result = await this.port.lookup(command.body);
      if (this.commands[0] !== command || result.commandId !== command.body.commandId) return;
      if (result.status === "applied") {
        this.settle(command, result);
        return;
      }
      if (result.status === "none") {
        this.settle(command, { status: "cancelled" });
        return;
      }
    } catch {
      // Remains unknown.
    }
    this.scheduleRetry(command);
  }

  private completeApply(command: ApplyCommand): void {
    if (command.answer) {
      this.resolving.delete(command);
      command.finish(command.answer);
      return;
    }
    this.resolving.add(command);
    if (!command.inFlight && !command.reading) void this.readResult(command);
  }

  private async readResult(command: ApplyCommand): Promise<void> {
    command.reading = true;
    for (const delay of [0, ...RETRY_DELAYS]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!this.resolving.has(command)) return;
      try {
        const result = await this.port.lookup(command.body);
        if (result.status === "applied" && result.commandId === command.body.commandId) {
          if (this.resolving.delete(command)) command.finish(result);
          return;
        }
      } catch {
        // The record already proves landing.
      }
    }
    if (this.resolving.delete(command))
      command.finish({ status: "landed", commandId: command.body.commandId });
  }

  private scheduleRetry(command: Command): void {
    const delay = RETRY_DELAYS[command.attempts++];
    if (delay === undefined) command.stalled = true;
    else this.retryTimer = setTimeout(() => void this.dispatch(command), delay);
    this.port.changed();
  }

  private clearFeedbackIfIdle(): void {
    if (this.clicks.length) return;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
    this.applying = false;
  }

  private release(command: Command): boolean {
    if (this.commands[0] !== command) return false;
    clearTimeout(this.retryTimer);
    this.commands.shift();
    if (this.request === command) this.request = null;
    this.clearFeedbackIfIdle();
    this.port.changed();
    this.moveOn();
    return true;
  }

  private settle(command: ApplyCommand, result: ApplyClickOutcome): void;
  private settle(command: UnapplyCommand, result: UnapplyClickOutcome): void;
  private settle(command: Command, result: ApplyClickOutcome | UnapplyClickOutcome): void {
    if (this.commands[0] !== command) return;
    // Folded before the release publishes, so the change doesn't flash back.
    if (
      command.kind === "apply" &&
      command.roomEnded &&
      result.status === "applied" &&
      textLanded(result, this.port.node)
    ) {
      const draftId = command.body.draftId;
      if (draftId && frozenOn(command, draftId))
        this.landedUnrecorded.set(draftId, [
          ...(this.landedUnrecorded.get(draftId) ?? []),
          command,
        ]);
    }
    this.release(command);
    if (command.kind === "apply") command.finish(result as ApplyClickOutcome);
    else command.finish(result as UnapplyClickOutcome);
  }
}
