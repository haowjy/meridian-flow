/** One bounded, fenced lifecycle for first and subsequent writer messages. */
import type { Thread } from "@meridian/contracts/protocol";
import type { SubmissionOutcome, ThreadRunController } from "@/client/copilot/ThreadRunController";
import { classifyWriteFailure } from "@/client/copilot/ThreadRunController";
import { abortable, type SubmissionLock } from "./lock";
import type { ChatSubmission } from "./store";

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
  status(entry: ChatSubmission, status: "pending" | "error", localFailure?: boolean): void;
  /** Consumed immediately before dispatch, never after an awaited request. */
  takeFresh(recordId: string): boolean;
  finished(entry: ChatSubmission): void;
  transferForEdit(entry: ChatSubmission, cohort: ChatSubmission[]): boolean;
  edited(entry: ChatSubmission): void;
  transferReceived(entry: ChatSubmission): boolean;
  timeoutMs?: number;
};

export class ChatSubmissionDriver {
  private readonly localFailures = new Set<string>();
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

  private async admissionRequest(
    operation: (signal: AbortSignal) => Promise<SubmissionOutcome>,
  ): Promise<SubmissionOutcome> {
    try {
      return await this.request(operation);
    } catch (error) {
      if (this.current() && !(error instanceof DOMException)) throw error;
      return { kind: this.current() ? "ambiguous" : "abandoned", submissionId: "" };
    }
  }

  drive(threadId: string): Promise<void> {
    const existing = this.drives.get(threadId);
    if (existing) return existing;
    const tried = new Set<string>();
    let entered = false;
    let blocked = false;
    const waiting = this.options.journal
      .entries()
      .filter((entry) => entry.threadId === threadId && !entry.state)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const driving = this.locked(
      threadId,
      async (derived) => {
        entered = true;
        while (this.current()) {
          const entry = this.options.journal
            .entries()
            .filter(
              (record) =>
                record.threadId === threadId &&
                (!record.state || this.options.transferReceived(record)) &&
                !tried.has(record.recordId),
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
          if (!entry) break;
          tried.add(entry.recordId);
          await this.guard(entry, () => this.attempt(entry, false, derived));
          if (!this.current()) return;
          // An unresolved predecessor may still land. Do not let later messages overtake it.
          const unresolved = this.read(entry.recordId);
          if (unresolved && !unresolved.state) {
            blocked = true;
            break;
          }
        }
      },
      waiting,
    ).finally(() => {
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
              record.threadId === threadId &&
              (!record.state || this.options.transferReceived(record)) &&
              !tried.has(record.recordId),
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
    if (this.options.transferReceived(original)) return this.edit(submissionId);
    this.options.status(original, "pending");
    return this.locked(
      original.threadId,
      async (derived) => {
        const entry = this.read(original.recordId);
        if (!entry || entry.submissionId !== submissionId || !this.current()) return;
        await this.guard(entry, () => this.attempt(entry, true, derived));
      },
      original,
    )
      .finally(() => this.options.finished(original))
      .then(() => {
        if (!this.current()) return;
        const remaining = this.read(original.recordId);
        if (!remaining || remaining.state) return this.drive(original.threadId);
      });
  }

  private async locked(
    threadId: string,
    operation: (derived: boolean) => Promise<void>,
    waiting?: ChatSubmission,
  ) {
    let entered = false;
    try {
      const derived = await this.options.whenDerived(threadId, this.options.signal);
      if (!this.current()) return;
      await this.options.lock.run(
        this.options.accountId,
        threadId,
        this.options.signal,
        async () => {
          if (!this.current()) return;
          entered = true;
          await operation(derived);
        },
      );
    } catch (error) {
      if (!this.current()) return;
      reportError(error);
      if (!entered && waiting) this.localFailure(waiting);
    }
  }

  private async guard(entry: ChatSubmission, operation: () => Promise<void>) {
    try {
      await operation();
    } catch (error) {
      if (!this.current()) return;
      reportError(error);
      this.localFailure(entry);
    } finally {
      this.options.finished(entry);
    }
  }

  private localFailure(entry: ChatSubmission) {
    this.localFailures.add(entry.recordId);
    try {
      this.options.status(entry, "error", true);
    } catch (error) {
      reportError(error);
    }
  }

  private write(entry: ChatSubmission): boolean {
    if (this.options.journal.record(entry)) {
      this.localFailures.delete(entry.recordId);
      return true;
    }
    this.localFailure(entry);
    return false;
  }

  private async attempt(original: ChatSubmission, retry: boolean, derived: boolean) {
    let entry = this.read(original.recordId);
    if (!entry || !this.current()) return;
    if (this.options.transferReceived(entry)) {
      const moving = entry;
      this.finishEdit(
        entry,
        entry.creation
          ? this.options.journal
              .entries()
              .filter(
                (record) =>
                  record.threadId === moving.threadId && this.options.transferReceived(record),
              )
          : [entry],
      );
      return;
    }
    const fresh = this.options.takeFresh(entry.recordId) && !retry;
    if (retry && entry.state) {
      entry = { ...entry, state: undefined };
      if (!this.current() || !this.write(entry)) return;
    }
    this.options.status(entry, "pending");
    if (!derived) {
      this.settle(entry, "rejected");
      return;
    }
    if (entry.creation) {
      const creating = entry;
      let thread: Thread;
      try {
        thread = await this.request((signal) => this.options.create(creating, signal));
      } catch (error) {
        if (this.current()) this.settle(entry, classifyWriteFailure(error));
        return;
      }
      if (!this.current()) return;
      for (const record of this.options.journal
        .entries()
        .filter((record) => record.threadId === entry?.threadId && record.creation)) {
        if (!this.current()) return;
        if (!this.write({ ...record, creation: undefined })) {
          this.localFailure(entry);
          return;
        }
      }
      this.options.created(thread);
      entry = this.read(original.recordId);
      if (!entry || !this.current()) return;
    }

    const rowId = this.options.row(entry);
    const options = { optimisticUserTurnId: rowId };
    if (!fresh) {
      const checking = entry;
      const outcome = await this.admissionRequest((signal) =>
        this.options.controller.lookupSubmission(
          checking.threadId,
          checking.submissionId,
          { ...options, signal },
          this.options.session,
        ),
      );
      if (!this.current()) return;
      if (outcome.kind === "abandoned") {
        this.settle(entry, "ambiguous");
        return;
      }
      if (outcome.kind === "accepted") {
        this.settle(entry, "accepted");
        return;
      }
      if (outcome.kind === "rejected" && retry) {
        entry = { ...entry, submissionId: crypto.randomUUID(), state: undefined };
        if (!this.current() || !this.write(entry)) return;
      } else if (outcome.kind !== "not-seen") {
        this.settle(entry, outcome.kind === "rejected" ? "rejected" : "ambiguous");
        return;
      }
    }
    if (!this.current()) return;
    const dispatching = entry;
    const outcome = await this.admissionRequest((signal) =>
      this.options.controller.recoverSubmission(
        dispatching.threadId,
        dispatching,
        { ...options, signal },
        this.options.session,
      ),
    );
    if (!this.current()) return;
    if (outcome.kind === "abandoned") {
      this.settle(entry, "ambiguous");
      return;
    }
    if (outcome.kind === "ambiguous") {
      await this.reconcileAmbiguous(entry, options);
      return;
    }
    this.settle(entry, outcome.kind === "not-seen" ? "ambiguous" : outcome.kind);
  }

  private async reconcileAmbiguous(
    entry: ChatSubmission,
    options: { optimisticUserTurnId: string },
  ) {
    const outcome = await this.admissionRequest((signal) =>
      this.options.controller.lookupSubmission(
        entry.threadId,
        entry.submissionId,
        { ...options, signal },
        this.options.session,
      ),
    );
    if (!this.current()) return;
    this.settle(
      entry,
      outcome.kind === "accepted" || outcome.kind === "rejected" ? outcome.kind : "ambiguous",
    );
  }

  private settle(entry: ChatSubmission, kind: "accepted" | "rejected" | "ambiguous") {
    if (!this.current()) return;
    if (kind === "accepted") {
      if (!this.options.journal.retire(entry.recordId)) this.localFailure(entry);
    } else {
      if (kind === "rejected" && !this.write({ ...entry, state: "rejected" })) return;
      if (this.current()) this.options.status(entry, "error");
    }
  }

  private finishEdit(entry: ChatSubmission, cohort: ChatSubmission[]) {
    for (const record of cohort) {
      if (!this.current()) return;
      if (!this.options.journal.retire(record.recordId)) {
        this.localFailure(record);
        return;
      }
    }
    if (this.current()) this.options.edited(entry);
  }

  edit(submissionId: string): Promise<void> {
    const original = this.options.journal
      .entries()
      .find((entry) => entry.submissionId === submissionId);
    if (
      !original?.draft ||
      original.state !== "rejected" ||
      (this.localFailures.has(original.recordId) && !this.options.transferReceived(original))
    )
      return Promise.resolve();
    return this.locked(original.threadId, () =>
      this.guard(original, async () => {
        const entry = this.read(original.recordId);
        if (
          !entry ||
          entry.submissionId !== submissionId ||
          entry.state !== "rejected" ||
          !this.current()
        )
          return;
        const received = this.options.transferReceived(entry);
        if (this.localFailures.has(entry.recordId) && !received) return;
        if (!entry.creation && !received) {
          const outcome = await this.admissionRequest((signal) =>
            this.options.controller.retireSubmission(
              entry.threadId,
              submissionId,
              {
                optimisticUserTurnId: this.options.row(entry),
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
          if (outcome.kind !== "rejected") {
            this.settle(entry, "ambiguous");
            return;
          }
        }
        if (!this.current()) return;
        const cohort = entry.creation
          ? this.options.journal
              .entries()
              .filter(
                (record) =>
                  record.threadId === entry.threadId &&
                  (!received || this.options.transferReceived(record)),
              )
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          : [entry];
        if (!received && !this.options.transferForEdit(entry, cohort)) return;
        this.finishEdit(entry, cohort);
      }),
    );
  }
}
