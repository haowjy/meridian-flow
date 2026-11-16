/** One review item's ordered Apply, Un-Apply, and Redo command schedule. */
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
  ApplyClickResult,
  UnapplyClick,
  UnapplyClickAnswer,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import type { Node as PMNode } from "@tiptap/pm/model";
import { itemOf } from "./draft-notices";

export type FrozenApply = {
  body: ApplyClick;
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  acknowledged: Promise<void>;
  /** A member of a several-item Apply sends through its group (`GroupApply`), not on its own. */
  send?: (body: ApplyClick) => Promise<ApplyClickAnswer>;
};

/** A click frozen on `draftId`'s room: the room folds it into its base until it records it. */
export function frozenOn(command: { body: ApplyClick }, draftId: string): boolean {
  return command.body.snapshot !== undefined && command.body.draftId === draftId;
}

export type ApplyClickLanded = { status: "landed"; commandId: string };
/** The click never reached the server: its room could not acknowledge it, or its id is another command's. */
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
  redo(): void;
  /**
   * Once nothing is outstanding: the Apply an Un-Apply takes back, and the click a Redo sends
   * again (a new command id to fill).
   */
  replay(): { applyCommandId: string; again: ApplyClick };
};
type ScheduledApplyHandle = ApplyCommandHandle & {
  current: ApplyCommand;
  reversal: Promise<UnapplyClickOutcome>;
  replaySelection: string[];
  /** The Un-Apply took this item's tree change back, so a Redo carries the tree cut again. */
  replayTree: boolean;
  pendingReplay: ApplyCommand | null;
};

export const APPLY_FEEDBACK_MS = 500;
const RETRY_DELAYS = [1000, 2000, 4000];

export class ApplyClickQueue {
  private readonly commands: Command[] = [];
  private readonly recorded = new Map<string, Set<string>>();
  private readonly recordedRows = new Map<string, { commandId: string; groupId?: string }[]>();
  private readonly resolving = new Set<ApplyCommand>();
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
    unapplyRefused(answer: UnapplyClickOutcome): void;
  }): { outcome: Promise<ApplyClickOutcome>; handle: ApplyCommandHandle } {
    const initial = this.queueApply(input.frozen);
    this.startFeedback();
    this.port.changed();
    // Either half landing gives the Apply something to take back; a Redo replays text alone.
    const landed = (answer: ApplyClickOutcome) => {
      if (answer.status === "landed") return true;
      if (answer.status !== "applied") return false;
      const item = itemOf(answer, this.port.node);
      return item?.tree?.landed === true || item?.text?.landed === true;
    };
    let handle!: ScheduledApplyHandle;
    handle = {
      current: initial,
      reversal: Promise.resolve({ status: "cancelled" }),
      replaySelection: [...initial.body.groupIds],
      replayTree: initial.body.tree === true,
      pendingReplay: null,
      undo: () => {
        input.intent();
        handle.pendingReplay = null;
        if (this.cancel(handle.current.body.commandId)) {
          handle.reversal = Promise.resolve({ status: "cancelled" });
          return handle.reversal;
        }
        handle.replaySelection = [...handle.current.body.groupIds];
        handle.replayTree = handle.current.body.tree === true;
        const inverse = this.queueUnapply({
          body: {
            commandId: crypto.randomUUID(),
            applyCommandId: handle.current.body.commandId,
          },
          draftId: handle.current.body.draftId ?? "",
          optimistic: handle.current.optimistic,
          patched: handle.current.patched,
          groupIds: handle.current.body.groupIds,
          patchFor: input.patchFor,
          ready: handle.current.outcome.then((answer) => {
            // Text that never landed has nothing to fold back while the Un-Apply is out.
            if (answer.status === "applied" && !itemOf(answer, this.port.node)?.text?.landed) {
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
        return inverse.heard.then((answer) => {
          if (answer.status === "unsent") input.unapplyRefused(answer);
          return answer;
        });
      },
      redo: () => {
        input.intent();
        const ready = handle.reversal.then((answer) => {
          if (answer.status !== "cancelled" && answer.status !== "unapplied")
            throw new Error("Un-Apply did not land");
        });
        handle.current = this.queueApply({
          body: {
            ...handle.current.body,
            commandId: crypto.randomUUID(),
            groupIds: [...handle.replaySelection],
            tree: handle.replayTree || undefined,
          },
          optimistic: handle.current.optimistic,
          patched: input.patchFor(handle.replaySelection),
          acknowledged: ready,
        });
        handle.pendingReplay = handle.current;
        this.startFeedback();
        this.port.changed();
        void handle.current.outcome.then((answer) => {
          if (answer.status !== "cancelled") input.replayed(answer);
        });
      },
      replay: () => ({
        applyCommandId: handle.current.body.commandId,
        again: { ...handle.current.body, groupIds: [...handle.replaySelection], tree: undefined },
      }),
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
      outcome,
      finish,
    };
    this.commands.push(command);
    void frozen.acknowledged.then(
      () => {
        if (!this.commands.includes(command)) return;
        command.acknowledged = Promise.resolve();
        if (this.commands[0] === command) void this.dispatch(command);
      },
      () => this.refuse(command),
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

  refuseUnsent(draftId: string): void {
    for (const command of this.clicks.filter((click) => frozenOn(click, draftId)))
      this.refuse(command);
  }

  close(draftId?: string): void {
    if (this.closed) return;
    if (draftId === undefined) {
      this.closed = true;
      clearTimeout(this.retryTimer);
    }
    const closing = this.clicks.filter(
      (command) => !command.closed && (draftId === undefined || command.body.draftId === draftId),
    );
    const head = this.commands[0];
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

  private refuse(command: ApplyCommand): void {
    const index = this.commands.indexOf(command);
    if (command.sent || index < 0) return;
    this.commands.splice(index, 1);
    command.finish({ status: "unsent", commandId: command.body.commandId });
    this.moveOn();
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
    try {
      await command.acknowledged;
    } catch {
      this.refuse(command);
      return;
    }
    if (this.request || this.commands[0] !== command) return;
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
      // receipt has no room to.
      if (
        !command.body.snapshot ||
        command.closed ||
        itemOf(answer, this.port.node)?.text?.landed !== true ||
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
      command.groupIds = new Set(answer.reversedGroupIds);
      command.patched = command.patchFor(answer.reversedGroupIds);
      command.selectionChanged(answer.reversedGroupIds, answer.treeUndone.includes(this.port.node));
      // The answer is acted on now (notice, history, hand-over); the room only settles it. A text
      // half that waits for its closed draft never leaves the room, so the answer settles it.
      command.hear(answer);
      if (answer.draftHalfWaits) this.settle(command, answer);
      else this.reconcileUnapply(command);
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
    if (!this.release(command)) return;
    if (command.kind === "apply") command.finish(result as ApplyClickOutcome);
    else command.finish(result as UnapplyClickOutcome);
  }
}
