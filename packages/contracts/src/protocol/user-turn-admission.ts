/** Durable writer-turn admission wire contracts. */
import { z } from "zod";
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

export type SkillOccurrence = {
  type: "skill";
  text: string;
  slug: string;
  name: string;
  description: string;
};

export type UserMessageBlock =
  | { type: "text"; text: string }
  | ReferenceOccurrence
  | SkillOccurrence
  | { type: "image"; documentId: DocumentId; uri: CanonicalContextUri };

/**
 * The durable turn block a submitted message block becomes. Server persistence
 * and the client's optimistic writer row both use it, so the row the writer
 * sees before admission carries the same occurrences the snapshot will.
 */
export function userMessageTurnBlock(block: UserMessageBlock): {
  blockType: "text" | "image";
  content: JsonValue;
} {
  switch (block.type) {
    case "text":
      return { blockType: "text", content: block.text };
    case "image":
      return {
        blockType: "image",
        content: { type: "image_reference", documentId: block.documentId, uri: block.uri },
      };
    default:
      return { blockType: "text", content: { ...block } };
  }
}

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
  text: string;
  blocks: unknown;
  references: readonly SubmittedReference[];
  /** Writer-picked skill slugs for this Send. Missing or empty means none. */
  activatedSkillSlugs?: readonly string[];
};

/** Fields proving the admission and the read/replay floors that belong to it. */
export const admissionReceiptShape = {
  threadId: z.string().min(1),
  userTurnId: z.string().min(1),
  runStateVersion: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .nullable(),
  resumeAfterSeq: z.string().regex(/^(0|[1-9]\d*)$/),
  snapshotFloorNextSeq: z.string().regex(/^(0|[1-9]\d*)$/),
};
export const admissionLookupSchema = z.discriminatedUnion("kind", [
  z.object({
    ...admissionReceiptShape,
    kind: z.enum(["accepted", "already-accepted"]),
    submissionId: z.string().min(1),
  }),
  z.object({ kind: z.enum(["pending", "not-seen"]), submissionId: z.string().min(1) }),
  z.object({
    kind: z.enum(["rejected", "retired"]),
    submissionId: z.string().min(1),
    code: z.string(),
  }),
]) satisfies z.ZodType<AdmissionLookup>;

export type AcceptedAdmission = {
  kind: "accepted" | "already-accepted";
  threadId: ThreadId;
  submissionId: string;
  userTurnId: TurnId;
  /** The stream version of the record the admission's own transaction published; null for older rows. */
  runStateVersion: string | null;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
};

export type AdmissionLookup =
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected"; submissionId: string; code: string }
  | { kind: "retired"; submissionId: string; code: string }
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

export type AdmissionErrorCode = "idempotency_conflict" | "invalid_message" | "work_unavailable";

export type UserTurnAdmissionResult = Exclude<AdmissionLookup, { kind: "not-seen" }>;

/** The read tool's supported keep-open selection, independent of document identity. */
export type ReferenceReadSelector =
  | { fragment: string }
  | { in: string | number | [string | number, string | number] };

const selectorEndpoint = z.union([
  z.string().regex(/^[0-9a-f]{4,}$/iu),
  z.number().int().positive().safe(),
]);
const referenceReadSelectorSchema = z.union([
  z
    .object({
      fragment: z
        .string()
        .min(1)
        .regex(/^[^#\s]+$/u),
    })
    .strict(),
  z
    .object({ in: z.union([selectorEndpoint, z.tuple([selectorEndpoint, selectorEndpoint])]) })
    .strict(),
]);

/** Server-generated snapshot; never accepted in a submitted reference. */
export type ReadReferenceOccurrence = ReferenceOccurrence & {
  read?: { result: JsonValue; revision: string | null; selector?: ReferenceReadSelector };
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
      Object.keys(read).filter((key) => key !== "selector").length !== 2 ||
      ("selector" in read && !referenceReadSelectorSchema.safeParse(read.selector).success) ||
      !("result" in read) ||
      read.result === undefined ||
      !("revision" in read) ||
      (read.revision !== null && typeof read.revision !== "string")
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

export function skillOccurrenceContent(block: {
  blockType: unknown;
  content: unknown;
}): SkillOccurrence | null {
  if (
    block.blockType !== "text" ||
    !block.content ||
    typeof block.content !== "object" ||
    Array.isArray(block.content)
  ) {
    return null;
  }
  const content = block.content as Record<string, unknown>;
  const keys = Object.keys(content).sort();
  if (
    keys.length !== 5 ||
    !["description", "name", "slug", "text", "type"].every((key, index) => keys[index] === key) ||
    content.type !== "skill" ||
    typeof content.slug !== "string" ||
    content.slug.length === 0 ||
    typeof content.name !== "string" ||
    typeof content.description !== "string" ||
    typeof content.text !== "string" ||
    content.text !== `/${content.slug}`
  ) {
    return null;
  }
  return content as SkillOccurrence;
}
