/** One bounded, fenced lifecycle for first and subsequent writer messages. */
import type { Thread } from "@meridian/contracts/protocol";
import type { EnqueueThreadControlResponse } from "@meridian/contracts/threads";
import { nextOccurrence } from "@meridian/thread-client";
import type { SubmissionOutcome, ThreadRunController } from "@/client/copilot/ThreadRunController";
import { classifyWriteFailure } from "@/client/copilot/ThreadRunController";
import { abortable, type SubmissionLock } from "./lock";
import { type ChatSubmission, compareSubmissions } from "./store";
import { threadAvailability } from "./thread-availability";

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
  /** Post a control record (a write-mode switch) to the chat's controls route. */
  postControl(entry: ChatSubmission, signal: AbortSignal): Promise<EnqueueThreadControlResponse>;
  row(entry: ChatSubmission): string;
  status(
    entry: ChatSubmission,
    status: "pending" | "error",
    localFailure?: "unsaved" | "lost",
  ): void;
  /** Consumed immediately before dispatch, never after an awaited request. */
  takeFresh(recordId: string): boolean;
  finished(entry: ChatSubmission): void;
  transferForEdit(entry: ChatSubmission, cohort: ChatSubmission[]): boolean;
  edited(entry: ChatSubmission): void;
  transferReceived(entry: ChatSubmission): boolean;
  deleted?(entry: ChatSubmission, reason: "deleted" | "project-deleted"): Promise<boolean>;
  timeoutMs?: number;
};

export class ChatSubmissionDriver {
  private readonly deletedThreads = new Set<string>();
  private readonly incompleteDeletions = new Map<string, "deleted" | "project-deleted">();
  private readonly localFailures = new Map<string, ChatSubmission>();
  private readonly drives = new Map<string, Promise<void>>();
  constructor(private readonly options: SubmissionDriverOptions) {}

  private current = () => !this.options.signal.aborted && this.options.isCurrent();
  private read(recordId: string) {
    return this.options.journal.entries().find((entry) => entry.recordId === recordId);
  }

  /**
   * A switch the server refused stays in the journal with its Retry and Withdraw,
   * and everything the writer did after it waits: a message would otherwise be
   * answered in the mode the writer already left. Withdraw releases them at once,
   * Retry once the switch is admitted.
   */
  private behindRejectedSwitch(record: ChatSubmission): boolean {
    return this.options.journal
      .entries()
      .some(
        (other) =>
          other.threadId === record.threadId &&
          other.control &&
          other.state === "rejected" &&
          other.recordId !== record.recordId &&
          compareSubmissions(other, record) < 0,
      );
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
    if (this.deletedThreads.has(threadId)) return Promise.resolve();
    const existing = this.drives.get(threadId);
    if (existing) return existing;
    const tried = new Set<string>();
    let entered = false;
    let blocked = false;
    const waiting = this.options.journal
      .entries()
      .filter((entry) => entry.threadId === threadId && !entry.state && !entry.answer)
      .sort(compareSubmissions)[0];
    const driving = this.locked(
      threadId,
      async (derived) => {
        entered = true;
        while (this.current() && !this.deletedThreads.has(threadId)) {
          const entry = this.options.journal
            .entries()
            .filter(
              (record) =>
                record.threadId === threadId &&
                !record.answer &&
                (!record.state ||
                  this.incompleteDeletions.has(threadId) ||
                  this.options.transferReceived(record)) &&
                !tried.has(record.recordId) &&
                !this.behindRejectedSwitch(record),
            )
            .sort(compareSubmissions)[0];
          if (!entry) break;
          tried.add(entry.recordId);
          await this.guard(entry, () => this.attempt(entry, false, derived));
          if (!this.current()) return;
          // An unresolved predecessor may still land. Do not let later messages overtake it.
          const unresolved = this.read(entry.recordId);
          if (unresolved && !unresolved.state && !unresolved.answer) {
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
              !record.answer &&
              (!record.state ||
                this.incompleteDeletions.has(threadId) ||
                this.options.transferReceived(record)) &&
              !tried.has(record.recordId) &&
              !this.behindRejectedSwitch(record),
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
    if (
      !original ||
      original.answer ||
      this.deletedThreads.has(original.threadId) ||
      !this.current()
    )
      return Promise.resolve();
    if (!this.incompleteDeletions.has(original.threadId) && this.options.transferReceived(original))
      return this.edit(submissionId);
    const requested = this.nextAttempt(original);
    this.options.status(requested, "pending");
    return this.locked(
      original.threadId,
      async (derived) => {
        const entry = this.read(original.recordId);
        if (!entry || entry.submissionId !== submissionId || !this.current()) return;
        await this.guard(requested, () => this.attempt(entry, true, derived, requested));
      },
      requested,
    )
      .finally(() => this.options.finished(original))
      .then(() => {
        if (!this.current()) return;
        const remaining = this.read(original.recordId);
        if (!remaining || remaining.state || remaining.answer) return this.drive(original.threadId);
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
      const saved = this.read(entry.recordId);
      this.localFailure(
        saved && (saved.occurrence?.attempt ?? 0) > (entry.occurrence?.attempt ?? 0)
          ? saved
          : entry,
      );
    } finally {
      this.options.finished(entry);
    }
  }

  private localFailure(entry: ChatSubmission, kind: "unsaved" | "lost" = "lost") {
    this.localFailures.set(entry.recordId, entry);
    try {
      this.options.status(entry, "error", kind);
    } catch (error) {
      reportError(error);
    }
  }

  private write(entry: ChatSubmission): boolean {
    if (this.options.journal.record(entry)) {
      this.localFailures.delete(entry.recordId);
      return true;
    }
    this.localFailure(entry, "unsaved");
    return false;
  }

  private nextAttempt(entry: ChatSubmission): ChatSubmission {
    return {
      ...entry,
      occurrence: nextOccurrence(
        Math.max(
          entry.occurrence?.attempt ?? 0,
          this.localFailures.get(entry.recordId)?.occurrence?.attempt ?? 0,
        ),
        crypto.randomUUID(),
      ),
    };
  }

  private async attempt(
    original: ChatSubmission,
    retry: boolean,
    derived: boolean,
    requested?: ChatSubmission,
  ) {
    let entry = this.read(original.recordId);
    if (!entry || !this.current()) return;
    const deletion = this.incompleteDeletions.get(entry.threadId);
    if (deletion) {
      await this.deleted(entry, { kind: deletion, submissionId: entry.submissionId });
      return;
    }
    if (this.options.transferReceived(entry)) {
      const moving = entry;
      this.finishEdit(
        entry,
        entry.creation
          ? this.options.journal
              .entries()
              .filter(
                (record) =>
                  record.threadId === moving.threadId &&
                  (record.control || this.options.transferReceived(record)),
              )
          : [entry],
      );
      return;
    }
    const fresh = this.options.takeFresh(entry.recordId) && !retry;
    const before = entry;
    entry = {
      ...entry,
      occurrence: (requested ?? (fresh && entry.occurrence ? entry : this.nextAttempt(entry)))
        .occurrence,
      ...(retry ? { state: undefined } : {}),
    };
    if (
      (entry.occurrence !== before.occurrence || entry.state !== before.state) &&
      !this.write(entry)
    )
      return;
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
        if (this.current()) {
          const availability = threadAvailability(error, this.options.accountId);
          if (availability === "deleted" || availability === "project-deleted")
            await this.deleted(entry, { kind: availability, submissionId: entry.submissionId });
          else this.settle(entry, classifyWriteFailure(error));
        }
        return;
      }
      if (!this.current()) return;
      for (const record of this.options.journal
        .entries()
        .filter((record) => record.threadId === entry?.threadId && record.creation)) {
        if (!this.current()) return;
        if (!this.write({ ...record, creation: undefined })) {
          this.localFailure(entry, "unsaved");
          return;
        }
      }
      this.options.created(thread);
      entry = this.read(original.recordId);
      if (!entry || !this.current()) return;
    }

    if (entry.control) {
      await this.postControl(entry);
      return;
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
      if (await this.deleted(entry, outcome)) return;
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
    if (await this.deleted(entry, outcome)) return;
    if (outcome.kind === "abandoned") {
      this.settle(entry, "ambiguous");
      return;
    }
    if (outcome.kind === "ambiguous") {
      await this.reconcileAmbiguous(entry, options);
      return;
    }
    this.settle(
      entry,
      outcome.kind === "accepted" || outcome.kind === "rejected" ? outcome.kind : "ambiguous",
    );
  }

  /**
   * A switch is one idempotent POST under its own id, so a repeat after a lost answer
   * is the original request. A refusal is stored; anything else leaves the record
   * unresolved and holds the records after it.
   */
  private async postControl(original: ChatSubmission) {
    // The mark is durable before the request leaves: from here the server may hold the
    // switch, so only its own Withdraw may remove it. A mark that cannot be written means
    // no request, and the writer keeps Retry and Withdraw.
    const entry = original.posted ? original : { ...original, posted: true as const };
    if (entry !== original && !this.write(entry)) return;
    let response: EnqueueThreadControlResponse;
    try {
      response = await this.request((signal) => this.options.postControl(entry, signal));
    } catch (error) {
      if (!this.current()) return;
      const availability = threadAvailability(error, this.options.accountId);
      if (availability === "deleted" || availability === "project-deleted")
        await this.deleted(entry, { kind: availability, submissionId: entry.submissionId });
      else this.settle(entry, classifyWriteFailure(error));
      return;
    }
    if (!this.current()) return;
    // The creation inputs are spent: the thread exists once the server answers a control.
    if (
      !this.write({
        ...entry,
        creation: undefined,
        answer: { runState: response.runState, at: Date.now() },
      })
    )
      return;
  }

  /**
   * Withdraw a switch the server can't have: take it out of the journal under the chat's
   * lock, so no driver is posting it meanwhile. That holds only when it was never posted or
   * the server refused it. `admitted` means the record is gone because the server has it,
   * and the server's own Withdraw is the way. `kept` means the server may have it and
   * hasn't said: a local removal could let a late request apply it, so it stays for Retry.
   */
  async withdrawControl(
    recordId: string,
    threadId: string,
  ): Promise<"removed" | "admitted" | "kept"> {
    let result = "admitted" as "removed" | "admitted" | "kept";
    await this.locked(threadId, async () => {
      const entry = this.read(recordId);
      if (!entry?.control || !this.current()) return;
      if (entry.answer) result = "admitted";
      else if (entry.posted && entry.state !== "rejected") result = "kept";
      else if (this.options.journal.retire(recordId)) result = "removed";
      else {
        this.localFailure(this.nextAttempt(entry), "unsaved");
        result = "kept";
      }
    });
    if (result === "removed") await this.drive(threadId);
    return result;
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
    if (await this.deleted(entry, outcome)) return;
    this.settle(
      entry,
      outcome.kind === "accepted" || outcome.kind === "rejected" ? outcome.kind : "ambiguous",
    );
  }

  private async deleted(entry: ChatSubmission, outcome: SubmissionOutcome): Promise<boolean> {
    if (outcome.kind !== "deleted" && outcome.kind !== "project-deleted") return false;
    this.incompleteDeletions.set(entry.threadId, outcome.kind);
    if (await this.options.deleted?.(entry, outcome.kind)) {
      this.incompleteDeletions.delete(entry.threadId);
      this.deletedThreads.add(entry.threadId);
    } else {
      for (const record of this.options.journal.entries())
        if (record.threadId === entry.threadId && !record.answer) this.settle(record, "rejected");
    }
    return true;
  }

  private settle(entry: ChatSubmission, kind: "accepted" | "rejected" | "ambiguous") {
    if (!this.current()) return;
    if (kind === "accepted") {
      if (!this.options.journal.retire(entry.recordId)) this.localFailure(entry, "unsaved");
    } else {
      if (kind === "rejected") {
        entry = { ...entry, state: "rejected" };
        if (!this.write(entry)) return;
      }
      if (this.current()) this.options.status(entry, "error");
    }
  }

  private finishEdit(entry: ChatSubmission, cohort: ChatSubmission[]) {
    for (const record of cohort) {
      if (!this.current()) return;
      if (!this.options.journal.retire(record.recordId)) {
        this.localFailure(record, "unsaved");
        return;
      }
    }
    if (this.current()) this.options.edited(entry);
  }

  edit(submissionId: string): Promise<void> {
    const original = this.options.journal
      .entries()
      .find((entry) => entry.submissionId === submissionId);
    if (original && this.incompleteDeletions.has(original.threadId))
      return this.retry(submissionId);
    if (
      !original?.draft ||
      this.deletedThreads.has(original.threadId) ||
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
          if (await this.deleted(entry, outcome)) return;
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
                  (!received || record.control || this.options.transferReceived(record)),
              )
              .sort(compareSubmissions)
          : [entry];
        if (!received && !this.options.transferForEdit(entry, cohort)) return;
        this.finishEdit(entry, cohort);
      }),
    );
  }
}
