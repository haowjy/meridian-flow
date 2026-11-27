import type {
  AcceptedAdmission,
  AdmissionFingerprint,
  AdmittedMessageBlock,
  UserTurnAdmissionInput,
  UserTurnAdmissionResult,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import {
  type TurnRepository,
  TurnStartConflictError,
  writerSendMetadata,
} from "../../threads/index.js";
import { activatedSkillMetadata } from "../loop/activated-skills.js";
import type { DeliveryProducer } from "../loop/delivery/runtime-delivery.js";
import { queuedWriteModeSwitch } from "../loop/next-inbox-work.js";
import type { PersistenceDeps } from "../loop/persistence.js";
import type { InboxReader } from "../loop/ports.js";
import type { RunningTurnView } from "../loop/run-session.js";
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
): UserTurnAdmissionResult {
  if (winner.fingerprint !== null && winner.fingerprint !== fingerprint) {
    throw new AdmissionConflictError();
  }
  if (winner.state === "accepted") return { ...winner.response, kind: "already-accepted" };
  if (winner.state === "pending") return { kind: "pending", submissionId };
  return {
    kind: winner.state,
    submissionId,
    code: winner.code,
  };
}

export function createWriterTurnProducer(deps: {
  persistence: PersistenceDeps;
  hub: { headSeq(threadId: ThreadId): Promise<bigint> };
  runner: { getRunningTurn(threadId: ThreadId): RunningTurnView | null };
  turns: Pick<TurnRepository, "findRunningAssistantId">;
  delivery: DeliveryProducer;
  inbox: Pick<InboxReader, "selectPending">;
  records: AdmissionPersistencePort;
  requireWritableThread(threadId: ThreadId): Promise<void>;
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
      blocks: readonly AdmittedMessageBlock[];
      references: readonly AuthorizedReference[];
      userTurnMetadata?: JsonValue | null;
    }) {
      const threadId = input.admission.threadId;
      const userTurnId = crypto.randomUUID() as TurnId;
      const liveReplyId = async () => {
        const live = deps.runner.getRunningTurn(threadId);
        if (!live || live.kind === "compaction") return null;
        return (
          live.turnId ??
          (await deps.turns.findRunningAssistantId(threadId, { createdAfter: live.startedAt }))
        );
      };
      const turnMetadata =
        activatedSkillMetadata(input.admission.activatedSkillSlugs ?? []) ??
        input.userTurnMetadata ??
        null;

      try {
        return await persistWriterEnqueue<UserTurnAdmissionResult>({
          persistence: deps.persistence,
          hub: deps.hub,
          threadId,
          userTurnId,
          userBlocks: input.blocks,
          joinedReply: async () => {
            const replyId = await liveReplyId();
            if (!replyId) return null;
            return queuedWriteModeSwitch(await deps.inbox.selectPending(threadId)) ? null : replyId;
          },
          userTurnMetadata: (joinedReplyId) =>
            writerSendMetadata(turnMetadata, joinedReplyId ? "steer" : "send"),
          delivery: deps.delivery,
          beforePersist: () => deps.requireWritableThread(threadId),
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
            runStateVersion,
            resumeAfterSeq,
            snapshotFloorNextSeq,
          }) => {
            const response: AcceptedAdmission = {
              kind: "accepted",
              threadId,
              submissionId: input.admission.submissionId,
              userTurnId: settledUserTurnId,
              runStateVersion,
              resumeAfterSeq,
              snapshotFloorNextSeq,
            };
            const accepted = await deps.records.accept({
              response,
              fingerprint: input.fingerprint,
            });
            if (accepted.kind === "winner") {
              throw new WriterEnqueueRollback(
                winnerProjection(accepted.record, input.fingerprint, input.admission.submissionId),
              );
            }
            const documentReferences = input.references.filter(
              (reference) => reference.kind === "document",
            );
            for (const reference of documentReferences) {
              await deps.attachDocument(threadId, reference.documentId, reference.relationship);
            }
            return accepted.response;
          },
        });
      } catch (error) {
        if (error instanceof TurnStartConflictError) {
          return { kind: "pending", submissionId: input.admission.submissionId };
        }
        throw error;
      }
    },
  };
}
