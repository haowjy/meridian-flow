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
import type { ThreadRunOwnership } from "../loop/thread-run-ownership.js";

export const MAX_USER_MESSAGE_BLOCKS = 64;
export const MAX_USER_MESSAGE_IMAGES = 16;
export const MAX_SUBMITTED_REFERENCES = 128;
export const MAX_REFERENCE_OCCURRENCES = 128;
export const MAX_DISTINCT_REFERENCE_IDENTITIES = 128;
export const MAX_USER_MESSAGE_TEXT = 200_000;
export const MAX_ACTIVATED_SKILL_SLUGS = 32;

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
  recoverExpiredPending(input: {
    threadId: string;
    submissionId: string;
    now: Date;
    hasLiveClaim(threadId: string): Promise<boolean>;
  }): Promise<AdmissionRecord | null>;
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
  | { state: "pending"; fingerprint: AdmissionFingerprint; claimExpiresAt: Date | null }
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
    if (
      exactObject(candidate, ["description", "name", "slug", "text", "type"]) &&
      candidate.type === "skill"
    ) {
      if (
        typeof candidate.slug !== "string" ||
        candidate.slug.length === 0 ||
        typeof candidate.name !== "string" ||
        typeof candidate.description !== "string" ||
        typeof candidate.text !== "string" ||
        candidate.text !== `/${candidate.slug}`
      ) {
        throw new InvalidAdmissionError(`blocks[${index}] has invalid skill identity`);
      }
      return {
        type: "skill",
        text: candidate.text,
        slug: candidate.slug,
        name: candidate.name,
        description: candidate.description,
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
      .filter(
        (block) => block.type === "text" || block.type === "reference" || block.type === "skill",
      )
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
    if (block.type === "text" || block.type === "skill") continue;
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

export function parseActivatedSkillSlugs(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ACTIVATED_SKILL_SLUGS) {
    throw new InvalidAdmissionError("activatedSkillSlugs must be a bounded array");
  }
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      throw new InvalidAdmissionError(`activatedSkillSlugs[${index}] is invalid`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    slugs.push(item);
  }
  return slugs;
}

export function canonicalAdmissionFingerprint(input: {
  actorUserId: string;
  threadId: string;
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  activatedSkillSlugs?: readonly string[];
}): AdmissionFingerprint {
  const canonical = JSON.stringify({
    actorUserId: input.actorUserId,
    threadId: input.threadId,
    text: input.text,
    blocks: input.blocks,
    references: input.references,
    activatedSkillSlugs: [...(input.activatedSkillSlugs ?? [])].sort(),
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
  runOwnership: ThreadRunOwnership;
  availability: ProjectContextAvailabilityPort;
  threadProject(threadId: string): Promise<string | null>;
  verifyDraftUpload?(reference: SubmittedReference & { intakeId: string }): Promise<boolean>;
  authorizeActivatedSkills?(input: { threadId: string; slugs: readonly string[] }): Promise<void>;
  starter: AdmissionTurnStarter;
  now?: () => Date;
}): UserTurnAdmission {
  const recover = async (
    threadId: string,
    submissionId: string,
    record: AdmissionRecord | null,
  ) => {
    const now = deps.now?.() ?? new Date();
    if (record?.state !== "pending" || !record.claimExpiresAt || record.claimExpiresAt > now)
      return record;
    // Match runner ordering and keep the claim until the recovery transaction commits.
    const claim = await deps.runOwnership.tryAcquire(threadId as never);
    if (!claim) return deps.records.lookup(threadId, submissionId);
    try {
      return await deps.records.recoverExpiredPending({
        threadId,
        submissionId,
        now,
        async hasLiveClaim() {
          return false;
        },
      });
    } finally {
      await claim.release();
    }
  };
  return {
    async lookup(request) {
      return lookupProjection(
        await recover(
          request.threadId,
          request.submissionId,
          await deps.records.lookup(request.threadId, request.submissionId),
        ),
        request.submissionId,
      );
    },
    async retire(request) {
      await recover(
        request.threadId,
        request.submissionId,
        await deps.records.lookup(request.threadId, request.submissionId),
      );
      return deps.records.retire(request);
    },
    async admit(input) {
      const blocks = parseUserMessageBlocks(input.blocks, input.text);
      const references = parseSubmittedReferences(input.references);
      validateReferenceMembership(blocks, references);
      const activatedSkillSlugs = parseActivatedSkillSlugs(input.activatedSkillSlugs);
      const fingerprint = canonicalAdmissionFingerprint({
        ...input,
        blocks,
        references,
        activatedSkillSlugs,
      });
      const existing = await deps.records.lookup(input.threadId, input.submissionId);
      if (existing) {
        assertMatchingFingerprint(existing, fingerprint);
        return lookupProjection(
          await recover(input.threadId, input.submissionId, existing),
          input.submissionId,
        ) as UserTurnAdmissionResult;
      }

      if (activatedSkillSlugs.length > 0) {
        if (!deps.authorizeActivatedSkills) {
          throw new Error("activated skill authorization is not configured");
        }
        await deps.authorizeActivatedSkills({
          threadId: input.threadId,
          slugs: activatedSkillSlugs,
        });
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
        return lookupProjection(
          await recover(input.threadId, input.submissionId, reservation.record),
          input.submissionId,
        ) as UserTurnAdmissionResult;
      }

      const projectId = await deps.threadProject(input.threadId);
      if (!projectId) throw new Error(`Thread project is unavailable: ${input.threadId}`);
      const ids = [
        ...new Set([
          ...references.map((reference) => reference.documentId),
          ...blocks
            .filter((block) => block.type === "reference" || block.type === "image")
            .map((block) => block.documentId),
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
        if (block.type === "text" || block.type === "skill") return [block];
        if (admittedIdentities.has(referenceIdentity(block))) return [block];
        return block.type === "reference" ? [{ type: "text", text: block.text }] : [];
      });
      return deps.starter.start({
        admission: { ...input, activatedSkillSlugs },
        fingerprint,
        blocks: admittedBlocks,
        references: admittedReferences,
      }) as Promise<UserTurnAdmissionResult>;
    },
  };
}
