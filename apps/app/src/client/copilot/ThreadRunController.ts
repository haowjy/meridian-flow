/**
 * Owns a writer submission from admission through transport recovery, and the interrupt
 * responses. It follows no run: the chat's run state is the mounted subscriber's
 * (`useThreadSnapshotSync`), and this controller only tells that view what the writer admitted.
 */
import type { SubmittedReference, UserMessageBlock } from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import { type InterruptRespondInput, isBusy, type ThreadTransport } from "@meridian/thread-client";
import { HttpResponseError } from "@/client/api/http-client";
import { isMeridianApiError } from "@/client/api/meridian-error";
import {
  appendUserMessage,
  lookupUserMessageAdmission,
  retireUserMessageAdmission,
} from "@/client/api/threads-api";
import { abortable } from "@/client/chat-submissions/lock";
import { threadAvailability } from "@/client/chat-submissions/thread-availability";
import type { ThreadStoreActions } from "@/client/stores";
import type { InterruptResponseState } from "@/core/session/interrupt-response";

type AppendUserMessageFn = typeof appendUserMessage;
type LookupAdmissionFn = typeof lookupUserMessageAdmission;
type RetireAdmissionFn = typeof retireUserMessageAdmission;

export type SubmitOptions = {
  signal: AbortSignal;
  /** Client-only turn id returned by appendUserTurn for this exact submit. */
  optimisticUserTurnId: string;
};

export type SubmissionPayload = {
  submissionId: string;
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  activatedSkillSlugs: readonly string[];
};

export type SubmissionOutcome = {
  kind:
    | "accepted"
    | "rejected"
    | "ambiguous"
    | "not-seen"
    | "abandoned"
    | "deleted"
    | "project-deleted";
  submissionId: string;
};

type SessionFence = () => boolean;

/** A refusal proves rejection; transport, server errors and pending admissions do not. */
export function classifyWriteFailure(error: unknown): "rejected" | "ambiguous" {
  if (error instanceof HttpResponseError || isMeridianApiError(error)) {
    if (error.status === 409 && error.message.includes("admission_pending")) return "ambiguous";
    if (error.status === undefined || (error.status >= 400 && error.status < 500))
      return "rejected";
  }
  return "ambiguous";
}

export type ThreadRunControllerOptions = {
  transport: ThreadTransport;
  actions: ThreadStoreActions;
  appendUserMessageFn?: AppendUserMessageFn;
  lookupAdmissionFn?: LookupAdmissionFn;
  retireAdmissionFn?: RetireAdmissionFn;
  accountSignal: AbortSignal;
  accountId: string;
};

export class ThreadRunController {
  private readonly transport: ThreadTransport;
  private readonly actions: ThreadStoreActions;
  private readonly appendUserMessageFn: AppendUserMessageFn;
  private readonly lookupAdmissionFn: LookupAdmissionFn;
  private readonly retireAdmissionFn: RetireAdmissionFn;
  private readonly accountSignal: AbortSignal;
  private readonly accountId: string;
  private disposed = false;
  private activationGeneration = 0;

  private recoverySessions = new Set<object>();
  private unsubscribeInterruptResponseError: (() => void) | null = null;
  private unsubscribeSocketGenerationClosed: (() => void) | null = null;

  constructor(options: ThreadRunControllerOptions) {
    this.transport = options.transport;
    this.actions = options.actions;
    this.appendUserMessageFn = options.appendUserMessageFn ?? appendUserMessage;
    this.lookupAdmissionFn = options.lookupAdmissionFn ?? lookupUserMessageAdmission;
    this.retireAdmissionFn = options.retireAdmissionFn ?? retireUserMessageAdmission;
    this.accountSignal = options.accountSignal;
    this.accountId = options.accountId;
  }

  /** Pair provider effect setup with disposal; construction is render-pure. */
  activate(): void {
    if (this.accountSignal.aborted || this.unsubscribeInterruptResponseError) return;
    this.disposed = false;
    const ownerGeneration = ++this.activationGeneration;
    this.unsubscribeInterruptResponseError = this.transport.onInterruptResponseError(
      ({ threadId, error }) => {
        if (
          !this.accountSignal.aborted &&
          !this.disposed &&
          this.activationGeneration === ownerGeneration
        )
          this.settleInterruptResponseError(threadId, error);
      },
    );
    try {
      this.unsubscribeSocketGenerationClosed = this.transport.onSocketGenerationClosed(
        (generation) =>
          !this.accountSignal.aborted &&
          !this.disposed &&
          this.activationGeneration === ownerGeneration &&
          this.actions.markInterruptResponsesForGenerationAmbiguous(generation),
      );
    } catch (error) {
      this.unsubscribeInterruptResponseError?.();
      this.unsubscribeInterruptResponseError = null;
      this.activationGeneration += 1;
      throw error;
    }
  }

  /** Re-admit a journal-recovered submission under its owning recovery session. */
  recoverSubmission(
    threadId: string,
    payload: SubmissionPayload,
    options: SubmitOptions,
    session: object,
  ): Promise<SubmissionOutcome> {
    return this.dispatch(threadId, payload, options, this.recoveryFence(session));
  }

  private recoveryFence(session: object): SessionFence {
    const ownerGeneration = this.activationGeneration;
    return () =>
      !this.disposed &&
      !this.accountSignal.aborted &&
      this.activationGeneration === ownerGeneration &&
      this.recoverySessions.has(session);
  }

  /** Register the mounted recovery owner for the current account/thread. */
  beginRecoverySession(session: object): void {
    this.recoverySessions.add(session);
  }

  endRecoverySession(session: object): void {
    this.recoverySessions.delete(session);
  }

  private async dispatch(
    threadId: string,
    envelope: SubmissionPayload,
    options: SubmitOptions,
    fence: SessionFence,
  ): Promise<SubmissionOutcome> {
    const outcome = (kind: SubmissionOutcome["kind"]): SubmissionOutcome => ({
      kind,
      submissionId: envelope.submissionId,
    });
    const signal = AbortSignal.any([this.accountSignal, options.signal]);
    const current = () => fence() && !signal.aborted;
    if (!current()) return outcome("abandoned");
    let result: Awaited<ReturnType<AppendUserMessageFn>>;
    try {
      result = await abortable(
        this.appendUserMessageFn({
          data: {
            threadId,
            submissionId: envelope.submissionId,
            text: envelope.text,
            blocks: envelope.blocks,
            references: envelope.references,
            activatedSkillSlugs: envelope.activatedSkillSlugs,
          },
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (!current()) return outcome("abandoned");
      const availability = threadAvailability(error, this.accountId);
      if (availability === "deleted" || availability === "project-deleted")
        return outcome(availability);
      if (classifyWriteFailure(error) === "rejected") {
        return outcome("rejected");
      }
      return outcome("ambiguous");
    }
    if (!current()) return outcome("abandoned");
    this.actions.acknowledgeUserTurn(
      threadId,
      options.optimisticUserTurnId,
      result.userTurnId,
      result.snapshotFloorNextSeq,
    );
    this.attachAcceptedRun(threadId, result);
    return outcome("accepted");
  }

  /** Reconcile a durable journal entry. */
  lookupSubmission(
    threadId: string,
    submissionId: string,
    options: SubmitOptions,
    session: object,
  ): Promise<SubmissionOutcome> {
    return this.reconcile(threadId, submissionId, options, "lookup", this.recoveryFence(session));
  }

  retireSubmission(
    threadId: string,
    submissionId: string,
    options: SubmitOptions,
    session: object,
  ): Promise<SubmissionOutcome> {
    return this.reconcile(threadId, submissionId, options, "retire", this.recoveryFence(session));
  }

  private async reconcile(
    threadId: string,
    submissionId: string,
    options: SubmitOptions,
    operation: "lookup" | "retire",
    fence: SessionFence,
  ): Promise<SubmissionOutcome> {
    const outcome = (kind: SubmissionOutcome["kind"]): SubmissionOutcome => ({
      kind,
      submissionId,
    });
    const signal = AbortSignal.any([this.accountSignal, options.signal]);
    const current = () => fence() && !signal.aborted;
    if (!current()) return outcome("abandoned");
    let result: Awaited<ReturnType<LookupAdmissionFn>> | Awaited<ReturnType<RetireAdmissionFn>>;
    try {
      result = await abortable(
        (operation === "retire" ? this.retireAdmissionFn : this.lookupAdmissionFn)({
          threadId,
          submissionId,
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (!current()) return outcome("abandoned");
      const availability = threadAvailability(error, this.accountId);
      if (availability === "deleted" || availability === "project-deleted")
        return outcome(availability);
      return outcome("ambiguous");
    }
    if (!current()) return outcome("abandoned");
    if (result.kind === "accepted" || result.kind === "already-accepted") {
      this.actions.acknowledgeUserTurn(
        threadId,
        options.optimisticUserTurnId,
        result.userTurnId,
        result.snapshotFloorNextSeq,
      );
      this.attachAcceptedRun(threadId, result);
      return outcome("accepted");
    }
    if (result.kind === "rejected" || result.kind === "retired") {
      return outcome("rejected");
    }
    if (result.kind === "not-seen") return outcome("not-seen");
    return outcome("ambiguous");
  }

  respondInterrupt(input: InterruptRespondInput): InterruptResponseState {
    // Overlap policy: one in-flight response per tuple. A second click while
    // this tuple is pending returns the existing state and writes nothing, so
    // the server cannot see a duplicate frame and the retained value is not
    // overwritten. Retry after a failed/ambiguous attempt is allowed.
    const existing = this.actions.interruptResponseFor(input);
    if (existing?.status === "pending") return { status: "pending" };

    // The wire envelope allows `unknown`; the component protocol only emits
    // JSON, so the retained retry value is a JsonValue.
    const value = input.value as JsonValue;
    const receipt = this.transport.respondInterrupt(input);
    if (!receipt.sent) {
      // The socket was not open, so the frame never left the client. This is a
      // proven send failure (retryable), not an ambiguous outcome.
      const failure: InterruptResponseState = { status: "failed" };
      this.actions.failInterruptResponse({ ...input, value }, failure);
      return failure;
    }
    // Record the socket generation so a close before any resolution can mark
    // this entry ambiguous (queued, not proven delivered).
    this.actions.beginInterruptResponse({
      ...input,
      value,
      generation: receipt.socketGeneration,
    });
    return { status: "pending" };
  }

  private settleInterruptResponseError(threadId: string, error: Error): void {
    const pending = this.actions.pendingInterruptResponseForThread(threadId);
    if (!pending) return;
    const code = isMeridianApiError(error) ? error.code : undefined;
    this.actions.failInterruptResponse(pending, {
      status: code === "interrupt_correlation_mismatch" ? "failed" : "ambiguous",
    });
  }

  /**
   * The lock-holding tab's admission. The chat owes the message until its record shows it
   * answered, so the admission becomes a message intent at the version its answer carries (none
   * for an older admission, whose record the subscriber already holds).
   */
  private attachAcceptedRun(
    threadId: string,
    result: { userTurnId: string; runStateVersion: string | null },
  ): void {
    if (this.disposed || this.accountSignal.aborted) return;
    // Only a fresh send onto an idle chat proves an earlier non-terminal assistant row is
    // abandoned; a chat that is working still owns its rows.
    if (!isBusy(this.actions.runState(threadId))) this.actions.pruneStaleAssistantTurns(threadId);
    if (result.runStateVersion !== null)
      this.actions.dispatchRunState(threadId, {
        type: "intent",
        intent: { kind: "message", id: result.userTurnId, answer: result.runStateVersion },
      });
  }

  /** Release controller-lifetime registrations (provider unmount). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activationGeneration += 1;
    this.recoverySessions.clear();
    this.unsubscribeInterruptResponseError?.();
    this.unsubscribeSocketGenerationClosed?.();
    this.unsubscribeInterruptResponseError = null;
    this.unsubscribeSocketGenerationClosed = null;
  }
}
