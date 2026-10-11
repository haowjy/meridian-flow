/** One bounded, fenced lifecycle for first and subsequent writer messages. */
import type { Thread } from "@meridian/contracts/protocol";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { classifyWriteFailure } from "@/client/copilot/ThreadRunController";
import { abortable, type SubmissionLock } from "./lock";
import type { ChatSubmission } from "./store";

export type SubmissionOutcome = {
  kind: "accepted" | "rejected" | "ambiguous" | "not-seen" | "abandoned";
  submissionId: string;
  acceptedRevision: number;
};

export type SubmissionJournal = {
  entries(): ChatSubmission[];
  record(entry: ChatSubmission): boolean;
  retire(recordId: string): boolean;
};

export type SubmissionDriverOptions = {
  accountId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  journal: SubmissionJournal;
  lock: SubmissionLock;
  controller: Pick<
    ThreadRunController,
    "recoverSubmission" | "lookupSubmission" | "retireSubmission"
  >;
  session: object;
  whenDerived(threadId: string, signal: AbortSignal): Promise<boolean>;
  create(entry: ChatSubmission, signal: AbortSignal): Promise<Thread>;
  created(thread: Thread): void;
  row(entry: ChatSubmission): string;
  status(entry: ChatSubmission, status: "pending" | "error"): void;
  /** Consumed immediately before dispatch, never after an awaited request. */
  takeFresh(recordId: string): boolean;
  transferForEdit(entry: ChatSubmission): string[] | null;
  edited(entry: ChatSubmission): void;
  timeoutMs?: number;
};

export class ChatSubmissionDriver {
  private readonly drives = new Map<string, Promise<void>>();
  constructor(private readonly options: SubmissionDriverOptions) {}

  private current = () => !this.options.signal.aborted && this.options.isCurrent();
  private read(recordId: string) {
    return this.options.journal.entries().find((entry) => entry.recordId === recordId);
  }

  /** Each request gets a new deadline. Ownership cancellation is never presented as failure. */
  private async request<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("Submission timed out", "TimeoutError")),
      this.options.timeoutMs ?? 15_000,
    );
    const signal = AbortSignal.any([this.options.signal, timeout.signal]);
    try {
      return await abortable(operation(signal), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  drive(threadId: string): Promise<void> {
    const existing = this.drives.get(threadId);
    if (existing) return existing;
    const tried = new Set<string>();
    let entered = false;
    let blocked = false;
    const driving = this.locked(threadId, async (derived) => {
      entered = true;
      while (this.current()) {
        const entry = this.options.journal
          .entries()
          .filter(
            (record) =>
              record.threadId === threadId && !record.state && !tried.has(record.recordId),
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!entry) break;
        tried.add(entry.recordId);
        await this.attempt(entry, false, derived);
        if (!this.current()) return;
        // An unresolved predecessor may still land. Do not let later messages overtake it.
        const unresolved = this.read(entry.recordId);
        if (unresolved && !unresolved.state) {
          blocked = true;
          break;
        }
      }
    }).finally(() => {
      this.drives.delete(threadId);
      // A Send can arrive after the final scan but before the lock callback settles.
      if (
        entered &&
        !blocked &&
        this.current() &&
        this.options.journal
          .entries()
          .some(
            (record) =>
              record.threadId === threadId && !record.state && !tried.has(record.recordId),
          )
      )
        void this.drive(threadId);
    });
    this.drives.set(threadId, driving);
    return driving;
  }

  retry(submissionId: string): Promise<void> {
    const original = this.options.journal
      .entries()
      .find((entry) => entry.submissionId === submissionId);
    if (!original || !this.current()) return Promise.resolve();
    this.options.status(original, "pending");
    return this.locked(original.threadId, async (derived) => {
      const entry = this.read(original.recordId);
      if (!entry || entry.submissionId !== submissionId || !this.current()) return;
      await this.attempt(entry, true, derived);
    }).then(() => {
      if (!this.current()) return;
      const remaining = this.read(original.recordId);
      if (!remaining || remaining.state) return this.drive(original.threadId);
    });
  }

  private async locked(threadId: string, operation: (derived: boolean) => Promise<void>) {
    try {
      const derived = await this.options.whenDerived(threadId, this.options.signal);
      if (!this.current()) return;
      await this.options.lock.run(
        this.options.accountId,
        threadId,
        this.options.signal,
        async () => {
          if (!this.current()) return;
          await operation(derived);
        },
      );
    } catch {
      // Ownership cancellation abandons the attempt. Its durable record is unchanged.
      if (this.current()) {
        for (const entry of this.options.journal
          .entries()
          .filter((entry) => entry.threadId === threadId && !entry.state)) {
          if (!this.current()) return;
          this.options.status(entry, "error");
        }
      }
    }
  }

  private async attempt(original: ChatSubmission, retry: boolean, derived: boolean) {
    let entry = this.read(original.recordId);
    if (!entry || !this.current()) return;
    const fresh = this.options.takeFresh(entry.recordId) && !retry;
    if (retry && entry.state) {
      entry = { ...entry, state: undefined };
      if (!this.current() || !this.options.journal.record(entry)) return;
    }
    this.options.status(entry, "pending");
    if (!derived) {
      this.settle(entry, "rejected");
      return;
    }
    if (entry.creation) {
      try {
        const creating = entry;
        const thread = await this.request((signal) => this.options.create(creating, signal));
        if (!this.current()) return;
        for (const record of this.options.journal
          .entries()
          .filter((record) => record.threadId === entry?.threadId && record.creation)) {
          if (!this.current()) return;
          if (!this.options.journal.record({ ...record, creation: undefined })) {
            this.options.status(entry, "error");
            return;
          }
        }
        if (!this.current()) return;
        this.options.created(thread);
        entry = this.read(original.recordId);
        if (!entry || !this.current()) return;
      } catch (error) {
        if (this.current() && entry) this.settle(entry, classifyWriteFailure(error));
        return;
      }
    }
    const rowId = this.options.row(entry);
    const options = { optimisticUserTurnId: rowId, keepOptimisticOnFailure: true };
    let dispatched = false;
    try {
      if (!fresh) {
        const checking = entry;
        const outcome = await this.request((signal) =>
          this.options.controller.lookupSubmission(
            checking.threadId,
            checking.submissionId,
            { ...options, signal },
            this.options.session,
          ),
        );
        if (!this.current()) return;
        if (outcome.kind === "abandoned") return;
        if (outcome.kind === "accepted") {
          this.settle(entry, "accepted");
          return;
        }
        if (outcome.kind === "rejected" && retry) {
          entry = { ...entry, submissionId: crypto.randomUUID(), state: undefined };
          if (!this.current() || !this.options.journal.record(entry)) return;
        } else if (outcome.kind !== "not-seen") {
          this.settle(entry, outcome.kind === "rejected" ? "rejected" : "ambiguous");
          return;
        }
      }
      if (!this.current()) return;
      dispatched = true;
      const dispatching = entry;
      const outcome = await this.request((signal) =>
        this.options.controller.recoverSubmission(
          dispatching.threadId,
          { ...dispatching, acceptedRevision: 0 },
          { ...options, signal },
          this.options.session,
        ),
      );
      if (!this.current()) return;
      if (outcome.kind === "abandoned") return;
      if (outcome.kind === "ambiguous") {
        await this.reconcileAmbiguous(entry, options);
        return;
      }
      this.settle(entry, outcome.kind === "not-seen" ? "ambiguous" : outcome.kind);
    } catch (error) {
      if (!this.current() || !entry) return;
      if (dispatched && classifyWriteFailure(error) === "ambiguous")
        await this.reconcileAmbiguous(entry, options);
      else this.settle(entry, classifyWriteFailure(error));
    }
  }

  private async reconcileAmbiguous(
    entry: ChatSubmission,
    options: { optimisticUserTurnId: string; keepOptimisticOnFailure: boolean },
  ) {
    try {
      const outcome = await this.request((signal) =>
        this.options.controller.lookupSubmission(
          entry.threadId,
          entry.submissionId,
          { ...options, signal },
          this.options.session,
        ),
      );
      if (!this.current() || outcome.kind === "abandoned") return;
      this.settle(
        entry,
        outcome.kind === "accepted" || outcome.kind === "rejected" ? outcome.kind : "ambiguous",
      );
    } catch {
      if (this.current()) this.settle(entry, "ambiguous");
    }
  }

  private settle(entry: ChatSubmission, kind: "accepted" | "rejected" | "ambiguous") {
    if (!this.current()) return;
    if (kind === "accepted") this.options.journal.retire(entry.recordId);
    else {
      if (kind === "rejected" && !this.options.journal.record({ ...entry, state: "rejected" }))
        return;
      if (this.current()) this.options.status(entry, "error");
    }
  }

  edit(submissionId: string): Promise<void> {
    const original = this.options.journal
      .entries()
      .find((entry) => entry.submissionId === submissionId);
    if (!original?.draft || original.state !== "rejected") return Promise.resolve();
    return this.locked(original.threadId, async () => {
      const entry = this.read(original.recordId);
      if (
        !entry ||
        entry.submissionId !== submissionId ||
        entry.state !== "rejected" ||
        !this.current()
      )
        return;
      if (!entry.creation) {
        const outcome = await this.request((signal) =>
          this.options.controller.retireSubmission(
            entry.threadId,
            submissionId,
            {
              optimisticUserTurnId: this.options.row(entry),
              keepOptimisticOnFailure: true,
              signal,
            },
            this.options.session,
          ),
        );
        if (!this.current()) return;
        if (outcome.kind === "accepted") {
          this.settle(entry, "accepted");
          return;
        }
        if (outcome.kind !== "rejected") return;
      }
      if (!this.current()) return;
      const transferred = this.options.transferForEdit(entry);
      if (!transferred) return;
      for (const recordId of transferred) {
        if (!this.current() || !this.options.journal.retire(recordId)) return;
      }
      if (this.current()) this.options.edited(entry);
    });
  }
}
