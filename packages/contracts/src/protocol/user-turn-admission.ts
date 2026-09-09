/** Durable writer-turn admission wire contracts. */
import { type CanonicalContextUri, parseContextUri } from "../context-uri.js";
import type { DocumentId, UserId } from "../ids.js";
import { parseRequestId } from "../request-id.js";
import type { ThreadId, TurnId } from "../runtime/index.js";
import type { JsonValue } from "../threads/index.js";

export type ReferenceOccurrence = {
  type: "reference";
  text: string;
  documentId: DocumentId;
  uri: CanonicalContextUri;
};

export type UserMessageBlock =
  | { type: "text"; text: string }
  | ReferenceOccurrence
  | { type: "image"; documentId: DocumentId; uri: CanonicalContextUri };

export type SubmittedReference = {
  documentId: DocumentId;
  uri: CanonicalContextUri;
  purpose: "reference" | "draft-upload";
  intakeId?: string;
};

export type AdmissionFingerprint = string;

export type UserTurnAdmissionInput = {
  actorUserId: UserId;
  threadId: ThreadId;
  submissionId: string;
  connectionToken?: string;
  text: string;
  blocks: unknown;
  references: readonly SubmittedReference[];
};

export type AcceptedAdmission = {
  kind: "accepted" | "already-accepted";
  threadId: ThreadId;
  submissionId: string;
  userTurnId: TurnId;
  assistantTurnId: TurnId;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
};

export type AdmissionLookup =
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected" | "retired"; submissionId: string; code: string }
  | { kind: "not-seen"; submissionId: string };

export type AdmissionLookupRequest = Pick<
  UserTurnAdmissionInput,
  "actorUserId" | "threadId" | "submissionId"
>;
export type RetireAdmissionRequest = AdmissionLookupRequest;
export type RetireAdmissionResult =
  | { kind: "retired"; submissionId: string; code: "retired" }
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected"; submissionId: string; code: string };

export type AdmissionErrorCode =
  | "idempotency_conflict"
  | "connection_token_not_live"
  | "already_running"
  | "invalid_message";

export type UserTurnAdmissionResult =
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected"; submissionId: string; code: AdmissionErrorCode };

/** Server-generated snapshot; never accepted in a submitted reference. */
export type ReadReferenceOccurrence = ReferenceOccurrence & {
  read?: { result: JsonValue };
};

export function referenceOccurrenceContent(block: {
  blockType: unknown;
  content: unknown;
}): ReadReferenceOccurrence | null {
  if (
    block.blockType !== "text" ||
    !block.content ||
    typeof block.content !== "object" ||
    Array.isArray(block.content)
  ) {
    return null;
  }
  const content = block.content as Record<string, unknown>;
  const keys = Object.keys(content)
    .filter((key) => key !== "read")
    .sort();
  if (
    keys.length !== 4 ||
    !["documentId", "text", "type", "uri"].every((key, index) => keys[index] === key) ||
    content.type !== "reference" ||
    typeof content.text !== "string" ||
    content.text.length === 0 ||
    typeof content.documentId !== "string" ||
    !parseRequestId(content.documentId) ||
    typeof content.uri !== "string"
  ) {
    return null;
  }
  if ("read" in content) {
    const read = content.read;
    if (
      !read ||
      typeof read !== "object" ||
      Array.isArray(read) ||
      Object.keys(read).length !== 1 ||
      !("result" in read) ||
      read.result === undefined
    )
      return null;
  }
  const parsedUri = parseContextUri(content.uri);
  if (
    !parsedUri.ok ||
    !content.uri.includes("://") ||
    parsedUri.value.path.length === 0 ||
    parsedUri.value.normalized !== content.uri
  ) {
    return null;
  }
  return content as ReadReferenceOccurrence;
}
