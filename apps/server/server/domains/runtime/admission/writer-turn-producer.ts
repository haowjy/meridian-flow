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
import type { TurnRepository } from "../../threads/index.js";
import type { PersistenceDeps } from "../loop/persistence.js";
import type { ThreadedInbox } from "../loop/threaded-inbox.js";
import { persistWriterEnqueue } from "../loop/writer-enqueue.js";
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
  turns: Pick<TurnRepository, "findRunningAssistantId">;
  threadedInbox: ThreadedInbox;
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
      // A live run means this send merges at its next boundary; the client keeps
      // the streaming assistant turn. A fresh run returns null.
      const assistantTurnId = await deps.turns.findRunningAssistantId(threadId);

      return persistWriterEnqueue<
        AcceptedAdmission | { kind: "pending" | "rejected"; submissionId: string; code?: string }
      >({
        persistence: deps.persistence,
        hub: deps.hub,
        workContextDelivery: deps.workContextDelivery,
        threadId,
        userTurnId,
        userBlocks: input.blocks,
        userTurnMetadata: input.userTurnMetadata,
        enqueue: () =>
          deps.threadedInbox
            .enqueue({
              id: userTurnId,
              threadId,
              intent: "message",
              provenance: { kind: "writer", actorId: input.admission.actorUserId },
              body: { kind: "text", text: input.admission.text },
              idempotencyKey: input.admission.submissionId,
            })
            .then(() => undefined),
        settle: async ({ userTurnId: settledUserTurnId, resumeAfterSeq, snapshotFloorNextSeq }) => {
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
            return winnerProjection(
              accepted.record,
              input.fingerprint,
              input.admission.submissionId,
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
    },
  };
}
