import { z } from "zod";
import { type CanonicalContextUri, parseContextUri } from "../context-uri.js";
import type { DocumentId, FolderId, UserId } from "../ids.js";
import { parseRequestId } from "../request-id.js";
import type { ThreadId, TurnId } from "../runtime/index.js";
import type { JsonObject, JsonValue, StoredMediaPart } from "../threads/index.js";

export type ReferenceOccurrence =
  | {
      type: "reference";
      kind: "document";
      text: string;
      documentId: DocumentId;
      uri: CanonicalContextUri;
    }
  | {
      type: "reference";
      kind: "folder";
      text: string;
      folderId: FolderId;
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

export type AdmittedMessageBlock =
  | Exclude<UserMessageBlock, { type: "image" }>
  | (Extract<UserMessageBlock, { type: "image" }> &
      Pick<StoredMediaPart, "mediaType" | "sizeBytes" | "name" | "chatCopy">);

export function userMessageTurnBlock(block: AdmittedMessageBlock): {
  blockType: "text" | "media";
  content: JsonValue;
} {
  switch (block.type) {
    case "text":
      return { blockType: "text", content: block.text };
    case "image":
      return {
        blockType: "media",
        content: {
          type: "media",
          ref: { documentId: block.documentId, uri: block.uri },
          mediaType: block.mediaType,
          sizeBytes: block.sizeBytes,
          name: block.name,
          ...(block.chatCopy ? { chatCopy: block.chatCopy } : {}),
        } satisfies StoredMediaPart,
      };
    default:
      return { blockType: "text", content: { ...block } };
  }
}

export function userMessageBlocksFromTurn(
  blocks: readonly { blockType: string; content: unknown; sequence?: number }[],
): UserMessageBlock[] {
  const ordered = [...blocks].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  return ordered.flatMap((block): UserMessageBlock[] => {
    if (block.blockType === "media") {
      const content = block.content as Partial<StoredMediaPart> | null;
      return content?.type === "media" && content.ref
        ? [
            {
              type: "image",
              documentId: content.ref.documentId as DocumentId,
              uri: content.ref.uri as CanonicalContextUri,
            },
          ]
        : [];
    }
    if (block.blockType !== "text") return [];
    if (typeof block.content === "string") return [{ type: "text", text: block.content }];
    const reference = referenceOccurrenceContent(block);
    if (reference) {
      if (reference.kind === "folder") return [reference];
      const { read: _read, ...document } = reference;
      return [document];
    }
    const skill = skillOccurrenceContent(block);
    return skill ? [skill] : [];
  });
}

export type SubmittedReference =
  | {
      kind: "document";
      documentId: DocumentId;
      uri: CanonicalContextUri;
      purpose: "reference" | "upload";
      intakeId?: string;
    }
  | { kind: "folder"; folderId: FolderId; uri: CanonicalContextUri };

export type AdmissionFingerprint = string;

export type UserTurnAdmissionInput = {
  actorUserId: UserId;
  threadId: ThreadId;
  submissionId: string;
  text: string;
  blocks: unknown;
  references: readonly SubmittedReference[];
  activatedSkillSlugs?: readonly string[];
};

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

export type UserTurnAdmissionResult = Exclude<AdmissionLookup, { kind: "not-seen" }>;

export type ReadReferenceOccurrence =
  | (Extract<ReferenceOccurrence, { kind: "document" }> & {
      read?: {
        result: JsonValue;
        revision: string | null;
        input?: JsonObject;
        media?: JsonValue;
      };
    })
  | Extract<ReferenceOccurrence, { kind: "folder" }>;

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
  const identityKey = content.kind === "folder" ? "folderId" : "documentId";
  if (
    keys.length !== 5 ||
    ![identityKey, "kind", "text", "type", "uri"]
      .sort()
      .every((key, index) => keys[index] === key) ||
    content.type !== "reference" ||
    (content.kind !== "document" && content.kind !== "folder") ||
    typeof content.text !== "string" ||
    content.text.length === 0 ||
    typeof content[identityKey] !== "string" ||
    !parseRequestId(content[identityKey]) ||
    typeof content.uri !== "string"
  ) {
    return null;
  }
  if ("read" in content) {
    if (content.kind !== "document") return null;
    const read = content.read;
    if (
      !read ||
      typeof read !== "object" ||
      Array.isArray(read) ||
      Object.keys(read).filter((key) => key !== "input" && key !== "media").length !== 2 ||
      ("input" in read &&
        (!read.input || typeof read.input !== "object" || Array.isArray(read.input))) ||
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
