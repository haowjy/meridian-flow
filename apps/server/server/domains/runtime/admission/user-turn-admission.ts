/** Authoritative parsing, identity, replay, and settlement for writer turns. */
import { createHash } from "node:crypto";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  AcceptedAdmission,
  AdmissionFingerprint,
  AdmissionLookup,
  AdmissionLookupRequest,
  RetireAdmissionRequest,
  RetireAdmissionResult,
  SubmittedReference,
  UserMessageBlock,
  UserTurnAdmissionInput,
  UserTurnAdmissionResult,
} from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { ProjectContextAvailabilityPort } from "../../context/index.js";

export const MAX_USER_MESSAGE_BLOCKS = 64;
export const MAX_USER_MESSAGE_IMAGES = 16;
export const MAX_SUBMITTED_REFERENCES = 128;
export const MAX_REFERENCE_OCCURRENCES = 128;
export const MAX_DISTINCT_REFERENCE_IDENTITIES = 128;
export const MAX_USER_MESSAGE_TEXT = 200_000;

export class InvalidAdmissionError extends Error {
  readonly code = "invalid_message" as const;
}

export class AdmissionConflictError extends Error {
  readonly code = "idempotency_conflict" as const;
}

export type AuthorizedReference = SubmittedReference & {
  relationship: "reading" | "created";
};

export interface AdmissionRecordPort {
  lookup(threadId: string, submissionId: string): Promise<AdmissionRecord | null>;
  reserve(input: {
    threadId: string;
    submissionId: string;
    actorUserId: string;
    fingerprint: AdmissionFingerprint;
    claimExpiresAt: Date;
  }): Promise<{ kind: "reserved" } | { kind: "winner"; record: AdmissionRecord }>;
  reject(input: {
    threadId: string;
    submissionId: string;
    fingerprint: AdmissionFingerprint;
    code: string;
  }): Promise<AdmissionRecord>;
  retire(request: RetireAdmissionRequest): Promise<RetireAdmissionResult>;
}

export type AdmissionRecord =
  | { state: "pending"; fingerprint: AdmissionFingerprint }
  | { state: "rejected" | "retired"; fingerprint: AdmissionFingerprint | null; code: string }
  | { state: "accepted"; fingerprint: AdmissionFingerprint; response: AcceptedAdmission };

export interface AdmissionTurnStarter {
  start(input: {
    admission: UserTurnAdmissionInput;
    fingerprint: AdmissionFingerprint;
    blocks: readonly UserMessageBlock[];
    references: readonly AuthorizedReference[];
  }): Promise<
    AcceptedAdmission | { kind: "pending" | "rejected"; submissionId: string; code?: string }
  >;
}

export interface UserTurnAdmission {
  admit(input: UserTurnAdmissionInput): Promise<UserTurnAdmissionResult>;
  lookup(request: AdmissionLookupRequest): Promise<AdmissionLookup>;
  retire(request: RetireAdmissionRequest): Promise<RetireAdmissionResult>;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalUri(value: unknown, location: string): string {
  if (typeof value !== "string") throw new InvalidAdmissionError(`${location} must be a URI`);
  const parsed = parseContextUri(value);
  if (!parsed.ok || !value.includes("://") || parsed.value.path.length === 0) {
    throw new InvalidAdmissionError(`${location} must be a canonical context URI`);
  }
  if (parsed.value.normalized !== value) {
    throw new InvalidAdmissionError(`${location} must already be canonical`);
  }
  return value;
}

export function parseUserMessageBlocks(value: unknown, text: string): UserMessageBlock[] {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_USER_MESSAGE_TEXT) {
    throw new InvalidAdmissionError("text is outside the accepted limits");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_USER_MESSAGE_BLOCKS) {
    throw new InvalidAdmissionError("blocks must be a non-empty bounded array");
  }
  let images = 0;
  let references = 0;
  const blocks = value.map((candidate, index): UserMessageBlock => {
    if (exactObject(candidate, ["type", "text"]) && candidate.type === "text") {
      if (typeof candidate.text !== "string" || candidate.text.length === 0) {
        throw new InvalidAdmissionError(`blocks[${index}] has invalid text`);
      }
      return { type: "text", text: candidate.text };
    }
    if (
      exactObject(candidate, ["type", "text", "documentId", "uri"]) &&
      candidate.type === "reference"
    ) {
      const documentId =
        typeof candidate.documentId === "string" ? parseRequestId(candidate.documentId) : null;
      if (!documentId || typeof candidate.text !== "string" || candidate.text.length === 0) {
        throw new InvalidAdmissionError(`blocks[${index}] has invalid reference identity`);
      }
      references += 1;
      if (references > MAX_REFERENCE_OCCURRENCES) {
        throw new InvalidAdmissionError("too many reference occurrences");
      }
      return {
        type: "reference",
        text: candidate.text,
        documentId: documentId as Extract<UserMessageBlock, { type: "reference" }>["documentId"],
        uri: canonicalUri(candidate.uri, `blocks[${index}].uri`),
      };
    }
    if (exactObject(candidate, ["type", "documentId", "uri"]) && candidate.type === "image") {
      const documentId =
        typeof candidate.documentId === "string" ? parseRequestId(candidate.documentId) : null;
      if (!documentId) throw new InvalidAdmissionError(`blocks[${index}] has invalid documentId`);
      images += 1;
      if (images > MAX_USER_MESSAGE_IMAGES)
        throw new InvalidAdmissionError("too many image blocks");
      return {
        type: "image",
        documentId: documentId as Extract<UserMessageBlock, { type: "image" }>["documentId"],
        uri: canonicalUri(candidate.uri, `blocks[${index}].uri`),
      } as UserMessageBlock;
    }
    throw new InvalidAdmissionError(`blocks[${index}] has an invalid shape`);
  });
  if (
    blocks
      .filter((block) => block.type === "text" || block.type === "reference")
      .map((block) => block.text)
      .join("") !== text
  ) {
    throw new InvalidAdmissionError("text must equal concatenated text blocks");
  }
  return blocks;
}

export function parseSubmittedReferences(value: unknown): SubmittedReference[] {
  if (!Array.isArray(value) || value.length > MAX_SUBMITTED_REFERENCES) {
    throw new InvalidAdmissionError("references must be a bounded array");
  }
  const identities = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new InvalidAdmissionError(`references[${index}] has an invalid shape`);
    }
    const record = candidate as Record<string, unknown>;
    const purpose = record.purpose;
    const expected =
      purpose === "draft-upload"
        ? ["documentId", "uri", "purpose", "intakeId"]
        : ["documentId", "uri", "purpose"];
    if (!exactObject(record, expected) || (purpose !== "reference" && purpose !== "draft-upload")) {
      throw new InvalidAdmissionError(`references[${index}] has an invalid shape`);
    }
    const documentId =
      typeof record.documentId === "string" ? parseRequestId(record.documentId) : null;
    if (
      !documentId ||
      (purpose === "draft-upload" && (typeof record.intakeId !== "string" || !record.intakeId))
    ) {
      throw new InvalidAdmissionError(`references[${index}] has invalid identity`);
    }
    const uri = canonicalUri(record.uri, `references[${index}].uri`);
    const key = `${documentId}\0${uri}`;
    if (identities.has(key)) {
      throw new InvalidAdmissionError("references must be deduplicated by identity");
    }
    identities.add(key);
    return {
      documentId: documentId as SubmittedReference["documentId"],
      uri,
      purpose,
      ...(purpose === "draft-upload" ? { intakeId: record.intakeId as string } : {}),
    };
  });
}

function referenceIdentity(reference: { documentId: string; uri: string }): string {
  return `${reference.documentId}\0${reference.uri}`;
}

function validateReferenceMembership(
  blocks: readonly UserMessageBlock[],
  references: readonly SubmittedReference[],
): void {
  const submitted = new Set(references.map(referenceIdentity));
  const distinct = new Set(submitted);
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") continue;
    const key = referenceIdentity(block);
    distinct.add(key);
    if (!submitted.has(key)) {
      throw new InvalidAdmissionError(`blocks[${index}] has no submitted reference`);
    }
    if (block.type === "image") {
      const previous = blocks[index - 1];
      if (previous?.type !== "reference" || referenceIdentity(previous) !== key) {
        throw new InvalidAdmissionError(`blocks[${index}] is not paired with its occurrence`);
      }
    }
  }
  if (distinct.size > MAX_DISTINCT_REFERENCE_IDENTITIES) {
    throw new InvalidAdmissionError("too many distinct reference identities");
  }
}

export function canonicalAdmissionFingerprint(input: {
  actorUserId: string;
  threadId: string;
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
}): AdmissionFingerprint {
  const canonical = JSON.stringify({
    actorUserId: input.actorUserId,
    threadId: input.threadId,
    text: input.text,
    blocks: input.blocks,
    references: input.references,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function lookupProjection(record: AdmissionRecord | null, submissionId: string): AdmissionLookup {
  if (!record) return { kind: "not-seen", submissionId };
  if (record.state === "accepted") return { ...record.response, kind: "already-accepted" };
  if (record.state === "pending") return { kind: "pending", submissionId };
  return { kind: record.state, submissionId, code: record.code };
}

function assertMatchingFingerprint(record: AdmissionRecord, fingerprint: string): void {
  if (record.fingerprint !== null && record.fingerprint !== fingerprint) {
    throw new AdmissionConflictError();
  }
}

export function createUserTurnAdmission(deps: {
  records: AdmissionRecordPort;
  availability: ProjectContextAvailabilityPort;
  threadProject(threadId: string): Promise<string | null>;
  verifyDraftUpload?(reference: SubmittedReference & { intakeId: string }): Promise<boolean>;
  starter: AdmissionTurnStarter;
  now?: () => Date;
}): UserTurnAdmission {
  return {
    async lookup(request) {
      return lookupProjection(
        await deps.records.lookup(request.threadId, request.submissionId),
        request.submissionId,
      );
    },
    retire: (request) => deps.records.retire(request),
    async admit(input) {
      const blocks = parseUserMessageBlocks(input.blocks, input.text);
      const references = parseSubmittedReferences(input.references);
      validateReferenceMembership(blocks, references);
      const fingerprint = canonicalAdmissionFingerprint({ ...input, blocks, references });
      const existing = await deps.records.lookup(input.threadId, input.submissionId);
      if (existing) {
        assertMatchingFingerprint(existing, fingerprint);
        return lookupProjection(existing, input.submissionId) as UserTurnAdmissionResult;
      }

      const now = deps.now?.() ?? new Date();
      const reservation = await deps.records.reserve({
        threadId: input.threadId,
        submissionId: input.submissionId,
        actorUserId: input.actorUserId,
        fingerprint,
        claimExpiresAt: new Date(now.getTime() + 5 * 60_000),
      });
      if (reservation.kind === "winner") {
        assertMatchingFingerprint(reservation.record, fingerprint);
        return lookupProjection(reservation.record, input.submissionId) as UserTurnAdmissionResult;
      }

      const projectId = await deps.threadProject(input.threadId);
      if (!projectId) throw new Error(`Thread project is unavailable: ${input.threadId}`);
      const ids = [
        ...new Set([
          ...references.map((reference) => reference.documentId),
          ...blocks.filter((block) => block.type !== "text").map((block) => block.documentId),
        ]),
      ];
      const resolved = await deps.availability.lookup(
        { projectId: projectId as never, documentIds: ids },
        { userId: input.actorUserId },
      );
      const available = new Map(
        resolved.resolutions
          .filter((item) => item.kind === "available")
          .map((item) => [item.documentId, item]),
      );
      const admittedReferences: AuthorizedReference[] = [];
      const admittedIdentities = new Set<string>();
      for (const reference of references) {
        const identity = available.get(reference.documentId);
        if (!identity || identity.entry.uri !== reference.uri) continue;
        if (
          reference.purpose === "draft-upload" &&
          deps.verifyDraftUpload &&
          !(await deps.verifyDraftUpload(reference as SubmittedReference & { intakeId: string }))
        ) {
          continue;
        }
        admittedIdentities.add(referenceIdentity(reference));
        admittedReferences.push({
          ...reference,
          relationship: reference.purpose === "draft-upload" ? "created" : "reading",
        });
      }
      const admittedBlocks = blocks.flatMap((block): UserMessageBlock[] => {
        if (block.type === "text") return [block];
        if (admittedIdentities.has(referenceIdentity(block))) return [block];
        return block.type === "reference" ? [{ type: "text", text: block.text }] : [];
      });
      return deps.starter.start({
        admission: input,
        fingerprint,
        blocks: admittedBlocks,
        references: admittedReferences,
      }) as Promise<UserTurnAdmissionResult>;
    },
  };
}
