/**
 * The writer producer: admission's `enqueue` step. It persists the writer's user
 * turn at enqueue (so the client's optimistic ack and the send's durability hold
 * before any run exists), appends a writer-provenance `message` to the durable
 * inbox under the same id, settles admission plus attachments, and wakes the
 * thread — all in one turn-start transaction. A live run's assistant turn id is
 * returned for a mid-run merge; a fresh run returns null and the client learns
 * the assistant turn from `RUN_STARTED`.
 *
 * No run is started here: the wake is best-effort latency, the sweep is the
 * durable guarantee, and the drain owns the assistant container.
 */
import type {
  AcceptedAdmission,
  AdmissionFingerprint,
  UserMessageBlock,
  UserTurnAdmissionInput,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { WorkContextDelivery } from "../../projects/index.js";
import { type TurnRepository, TurnStartConflictError } from "../../threads/index.js";
import { activatedSkillMetadata } from "../loop/activated-skills.js";
import type { PersistenceDeps } from "../loop/persistence.js";
import type { Inbox } from "../loop/ports.js";
import type { RunningTurnView } from "../loop/run-session.js";
import type { ThreadedInbox } from "../loop/threaded-inbox.js";
import { persistWriterEnqueue, WriterEnqueueRollback } from "../loop/writer-enqueue.js";
import type { AdmissionPersistencePort } from "./drizzle-admission-records.js";
import {
  AdmissionConflictError,
  type AdmissionRecord,
  type AdmissionWriterProducer,
  type AuthorizedReference,
} from "./user-turn-admission.js";

function winnerProjection(
  winner: AdmissionRecord,
  fingerprint: string,
  submissionId: string,
): AcceptedAdmission | { kind: "pending" | "rejected"; submissionId: string; code?: string } {
  if (winner.fingerprint !== null && winner.fingerprint !== fingerprint) {
    throw new AdmissionConflictError();
  }
  if (winner.state === "accepted") return { ...winner.response, kind: "already-accepted" };
  if (winner.state === "pending") return { kind: "pending", submissionId };
  return {
    kind: "rejected",
    submissionId,
    code: winner.state === "retired" ? "retired" : winner.code,
  };
}

export function createWriterTurnProducer(deps: {
  persistence: PersistenceDeps;
  hub: { headSeq(threadId: ThreadId): Promise<bigint> };
  /** Liveness authority: the runner owns which threads have a live run. */
  runner: { getRunningTurn(threadId: ThreadId): RunningTurnView | null };
  /** Setup-window fallback only; consulted while the runner owns the thread. */
  turns: Pick<TurnRepository, "findRunningAssistantId">;
  threadedInbox: ThreadedInbox;
  inbox: Pick<Inbox, "listPending">;
  workContextDelivery: Pick<WorkContextDelivery, "beforeTurn">;
  records: AdmissionPersistencePort;
  consumeUploads(documentIds: readonly string[]): Promise<void>;
  attachDocument(
    threadId: string,
    documentId: string,
    relationship: "reading" | "created",
  ): Promise<unknown>;
}): AdmissionWriterProducer {
  return {
    async enqueue(input: {
      admission: UserTurnAdmissionInput;
      fingerprint: AdmissionFingerprint;
      blocks: readonly UserMessageBlock[];
      references: readonly AuthorizedReference[];
      userTurnMetadata?: JsonValue | null;
    }) {
      const threadId = input.admission.threadId;
      const userTurnId = crypto.randomUUID() as TurnId;
      // Liveness comes from the runner map, never durable turn status: a
      // crash-orphaned `streaming` turn is not a live run, and a run parked on
      // `waiting_interrupt` is. Only once the runner owns the thread do we look
      // at durable rows, and only for the setup window where the runner has not
      // published the assistant id yet. `createdAfter` keeps an older orphan out.
      const live = deps.runner.getRunningTurn(threadId);
      const assistantTurnId = live
        ? (live.assistantTurnId ??
          (await deps.turns.findRunningAssistantId(threadId, {
            createdAfter: live.startedAt,
          })))
        : null;

      type Projection =
        | AcceptedAdmission
        | { kind: "pending" | "rejected"; submissionId: string; code?: string };
      try {
        return await persistWriterEnqueue<Projection>({
          persistence: deps.persistence,
          hub: deps.hub,
          workContextDelivery: deps.workContextDelivery,
          threadId,
          userTurnId,
          userBlocks: input.blocks,
          userTurnMetadata:
            activatedSkillMetadata(input.admission.activatedSkillSlugs ?? []) ??
            input.userTurnMetadata ??
            null,
          threadedInbox: deps.threadedInbox,
          inbox: deps.inbox,
          draft: {
            id: userTurnId,
            threadId,
            intent: "message",
            provenance: { kind: "writer", actorId: input.admission.actorUserId },
            body: { kind: "text", text: input.admission.text },
            idempotencyKey: input.admission.submissionId,
          },
          settle: async ({
            userTurnId: settledUserTurnId,
            resumeAfterSeq,
            snapshotFloorNextSeq,
          }) => {
            const response: AcceptedAdmission = {
              kind: "accepted",
              threadId,
              submissionId: input.admission.submissionId,
              userTurnId: settledUserTurnId,
              assistantTurnId,
              resumeAfterSeq,
              snapshotFloorNextSeq,
            };
            const accepted = await deps.records.accept({
              response,
              fingerprint: input.fingerprint,
            });
            if (accepted.kind === "winner") {
              // A concurrent settlement won: the turn and inbox append already
              // staged in this transaction must not commit. Throwing rolls the
              // whole transition back and carries the winner projection out.
              throw new WriterEnqueueRollback(
                winnerProjection(accepted.record, input.fingerprint, input.admission.submissionId),
              );
            }
            await deps.consumeUploads(
              input.references
                .filter((reference) => reference.purpose === "draft-upload")
                .map((reference) => reference.documentId),
            );
            for (const reference of input.references) {
              await deps.attachDocument(threadId, reference.documentId, reference.relationship);
            }
            return accepted.response;
          },
        });
      } catch (error) {
        // The retry budget for the thread's turn-start transition is exhausted: a
        // concurrent turn start kept winning. Report the reservation as pending so
        // the route maps it to 409 and the client reconciles, not a 500.
        if (error instanceof TurnStartConflictError) {
          return { kind: "pending", submissionId: input.admission.submissionId };
        }
        throw error;
      }
    },
  };
}
