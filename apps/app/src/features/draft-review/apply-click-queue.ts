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

export type FrozenApply = {
  body: ApplyClick;
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  acknowledged: Promise<void>;
};

function isFinalApplyRefusal(
  answer: ApplyClickObservation,
): answer is Exclude<ApplyClickResult, { status: "applied" }> {
  return ["closed", "refused", "needs_restore", "changed"].includes(answer.status);
}

export type ApplyClickLanded = { status: "landed"; commandId: string };
export type ApplyClickOutcome = ApplyClickResult | ApplyClickLanded | { status: "cancelled" };
export type UnapplyClickOutcome = UnapplyClickResult | { status: "cancelled" };

type ApplyCommand = FrozenApply & {
  kind: "apply";
  release: Promise<{ cancel?: boolean; omitTree?: boolean }>;
  sent: boolean;
  attempts: number;
  stalled: boolean;
  closed: boolean;
  answer?: ApplyClickResult;
  inFlight?: boolean;
  reading?: boolean;
  finish(result: ApplyClickOutcome): void;
};
export type UnapplyCommand = {
  kind: "unapply";
  body: UnapplyClick;
  draftId: string;
  frozen: FrozenApply;
  ready: Promise<boolean>;
  groupIds: Set<string>;
  sent: boolean;
  attempts: number;
  stalled: boolean;
  answer?: UnapplyClickResult;
  finish(result: UnapplyClickOutcome): void;
};
type Command = ApplyCommand | UnapplyCommand;

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

  enqueue(
    frozen: FrozenApply,
    release: Promise<{ cancel?: boolean; omitTree?: boolean }> = Promise.resolve({}),
  ): Promise<ApplyClickOutcome> {
    if (this.closed) return Promise.resolve({ status: "cancelled" });
    const result = new Promise<ApplyClickOutcome>((finish) => {
      const command: ApplyCommand = {
        kind: "apply",
        ...frozen,
        release,
        sent: false,
        attempts: 0,
        stalled: false,
        closed: false,
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
    });
    this.startFeedback();
    this.port.changed();
    return result;
  }

  enqueueUnapply(input: {
    body: UnapplyClick;
    draftId: string;
    frozen: FrozenApply;
    ready: Promise<boolean>;
  }): Promise<UnapplyClickOutcome> {
    if (this.closed) return Promise.resolve({ status: "cancelled" });
    const result = new Promise<UnapplyClickOutcome>((finish) => {
      this.commands.push({
        kind: "unapply",
        ...input,
        groupIds: new Set(input.frozen.body.groupIds),
        sent: false,
        attempts: 0,
        stalled: false,
        finish,
      });
    });
    this.port.changed();
    this.moveOn();
    return result;
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
    for (const command of this.clicks.filter((click) => click.body.draftId === draftId))
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
    command.finish({ status: "refused", commandId: command.body.commandId, reason: "unsynced" });
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
      const [, released] = await Promise.all([command.acknowledged, command.release]);
      if (released.cancel) {
        this.commands.splice(this.commands.indexOf(command), 1);
        command.finish({ status: "cancelled" });
        this.moveOn();
        return;
      }
      if (released.omitTree && command.body.tree)
        command.body = { ...command.body, tree: undefined };
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
        : this.port.send(command.body));
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
      if (!command.body.draftId || command.closed || this.isRecorded(command))
        this.settle(command, answer);
      return;
    }
    if (answer && isFinalApplyRefusal(answer)) {
      this.settle(command, answer);
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
      this.port.changed();
      this.reconcileUnapply(command);
      return;
    }
    if (answer?.status === "closed" || answer?.status === "refused") {
      this.settle(command, answer);
      return;
    }
    this.scheduleRetry(command);
  }

  reviseApply(commandId: string, frozen: FrozenApply): void {
    const command = this.commands.find(
      (candidate): candidate is ApplyCommand =>
        candidate.kind === "apply" && candidate.body.commandId === commandId && !candidate.sent,
    );
    if (!command) return;
    command.body = frozen.body;
    command.optimistic = frozen.optimistic;
    command.patched = frozen.patched;
    this.port.changed();
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
      if (result.status === "applied" || isFinalApplyRefusal(result)) {
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
