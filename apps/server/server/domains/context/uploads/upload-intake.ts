/** Authoritative, resumable upload intake aggregate. */
import { createHash } from "node:crypto";
import type {
  DeleteDraftUploadInput,
  DeleteDraftUploadResult,
  Filetype,
  UploadIntakeError,
  UploadIntakeResult,
  UploadOwner,
} from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  documentFileTypeFor,
  filetypeForKnownMimeType,
  filetypeForKnownPath,
} from "@meridian/contracts/protocol";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";

export interface UploadIntakeInput {
  intakeId: string;
  actorUserId: string;
  owner: UploadOwner;
  filename: string;
  mimeType: string;
  byteDigest: string;
  bytes: Uint8Array;
}

export type UploadIntakeOutcome =
  | { ok: true; value: UploadIntakeResult }
  | { ok: false; error: UploadIntakeError };

export interface UploadReservation {
  projectId: string;
  intakeId: string;
  documentId: string;
  fingerprint: string;
  finalPath: string;
  objectKey: string;
  canonicalUri: string;
  locationRevision: string;
  fileType: Filetype;
  state: "reserved" | "object_stored" | "finalized" | "deleted";
  storageUrl: string | null;
  consumed: boolean;
  owner: { kind: "none" } | { kind: "work"; workId: string; workSlug: string };
}

export type ReserveUploadResult =
  | { kind: "reserved" | "existing"; reservation: UploadReservation }
  | { kind: "conflict" }
  | { kind: "owner_unavailable" };

/** SQL lifecycle owner. Transactions must join the process ambient DB transaction. */
export interface UploadIntakeRepository {
  reserve(input: {
    intakeId: string;
    actorUserId: string;
    owner: UploadOwner;
    filename: string;
    mimeType: string;
    byteDigest: string;
    fingerprint: string;
    fileType: Filetype;
  }): Promise<ReserveUploadResult>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  markObjectStored(projectId: string, intakeId: string, storageUrl: string): Promise<void>;
  resetObjectStored(projectId: string, intakeId: string): Promise<void>;
  lockForFinalize(projectId: string, intakeId: string): Promise<UploadReservation>;
  finalize(projectId: string, intakeId: string): Promise<UploadReservation>;
  deleteDraft(
    input: DeleteDraftUploadInput,
    actorUserId: string,
  ): Promise<{
    result: DeleteDraftUploadResult;
    objectKey?: string;
  }>;
  /** F5 includes this singular seam in the admission transaction. */
  consume(documentIds: readonly string[]): Promise<void>;
}

/** ContextFS adapter seam; it is the only content/catalog mutation dependency. */
export interface UploadContentPort {
  persist(input: {
    reservation: UploadReservation;
    actorUserId: string;
    mimeType: string;
    bytes: Uint8Array;
    storageUrl: string | null;
  }): Promise<{ ok: true } | { ok: false; definite: boolean }>;
}

export interface UploadIntake {
  intake(input: UploadIntakeInput): Promise<UploadIntakeOutcome>;
  deleteDraft(input: DeleteDraftUploadInput, actorUserId: string): Promise<DeleteDraftUploadResult>;
  consume(documentIds: readonly string[]): Promise<void>;
}

const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/markdown",
  "application/toml",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
]);

function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function normalizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop()?.normalize("NFKC").trim() || "upload";
  const safe = [...basename]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .replace(/^@+/, "")
    .trim();
  return !safe || safe === "." || safe === ".." ? "upload" : safe;
}

export function classifyUpload(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Filetype {
  const mime = normalizeMime(input.mimeType);
  const byMime = filetypeForKnownMimeType(mime);
  const byPath = filetypeForKnownPath(input.filename);
  const textLike =
    mime.startsWith("text/") ||
    TEXT_MIMES.has(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    (!input.bytes.includes(0) && mime === "application/octet-stream" && byPath !== null);
  if (textLike) {
    const candidate = byPath ?? byMime ?? "text";
    const classification = classifyFiletype(candidate);
    if (classification.kind === "tracked") return candidate;
    return classification.kind === "unknown" ? "text" : classification.fileType;
  }
  const candidate = byMime ?? byPath;
  if (candidate) {
    const classification = classifyFiletype(candidate);
    if (classification.kind === "binary" || classification.kind === "custom") {
      return classification.fileType;
    }
  }
  return documentFileTypeFor({ filetype: null, mimeType: mime }) ?? "binary";
}

function fingerprint(input: {
  actorUserId: string;
  owner: UploadOwner;
  filename: string;
  mimeType: string;
  byteDigest: string;
}): string {
  const owner =
    input.owner.kind === "work"
      ? `work:${input.owner.projectId}:${input.owner.workId}`
      : `none:${input.owner.projectId}`;
  return createHash("sha256")
    .update(
      JSON.stringify([input.actorUserId, owner, input.filename, input.mimeType, input.byteDigest]),
    )
    .digest("hex");
}

async function cleanupObject(
  objectStore: ObjectStorePort,
  eventSink: EventSink,
  key: string,
  documentId: string,
): Promise<void> {
  try {
    const result = await objectStore.delete(key);
    if (!result.ok) throw new Error(result.error.message);
  } catch (cause) {
    emitEvent(eventSink, {
      level: "warn",
      source: "context.upload-intake",
      name: "object_compensation.failed",
      payload: { documentId, key, ...unknownToEventPayload(cause) },
    });
  }
}

export function createUploadIntake(deps: {
  repository: UploadIntakeRepository;
  content: UploadContentPort;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
}): UploadIntake {
  return {
    async intake(raw) {
      const filename = normalizeFilename(raw.filename);
      const mimeType = normalizeMime(raw.mimeType);
      const byteDigest = raw.byteDigest.trim().toLowerCase();
      const actualDigest = createHash("sha256").update(raw.bytes).digest("hex");
      if (actualDigest !== byteDigest)
        return { ok: false, error: { code: "idempotency_conflict" } };
      const fileType = classifyUpload({ filename, mimeType, bytes: raw.bytes });
      const canonicalFingerprint = fingerprint({
        actorUserId: raw.actorUserId,
        owner: raw.owner,
        filename,
        mimeType,
        byteDigest,
      });
      const reserved = await deps.repository.reserve({
        intakeId: raw.intakeId,
        actorUserId: raw.actorUserId,
        owner: raw.owner,
        filename,
        mimeType,
        byteDigest,
        fingerprint: canonicalFingerprint,
        fileType,
      });
      if (reserved.kind === "conflict")
        return { ok: false, error: { code: "idempotency_conflict" } };
      if (reserved.kind === "owner_unavailable")
        return { ok: false, error: { code: "owner_unavailable" } };
      let reservation = reserved.reservation;
      if (reservation.state === "deleted")
        return { ok: false, error: { code: "idempotency_conflict" } };
      if (reservation.state === "finalized") {
        return {
          ok: true,
          value: {
            documentId: reservation.documentId,
            uri: reservation.canonicalUri,
            fileType: reservation.fileType,
            locationRevision: reservation.locationRevision,
          },
        };
      }

      const tracked = classifyFiletype(reservation.fileType).kind === "tracked";
      let storageUrl = reservation.storageUrl;
      let storedThisAttempt = false;
      if (!tracked && !storageUrl) {
        const stored = await deps.objectStore.put(reservation.objectKey, raw.bytes, mimeType);
        if (!stored.ok) return { ok: false, error: { code: "storage_failed" } };
        storageUrl = stored.value.storageUrl;
        storedThisAttempt = true;
        await deps.repository.markObjectStored(raw.owner.projectId, raw.intakeId, storageUrl);
        reservation = { ...reservation, state: "object_stored", storageUrl };
      }

      try {
        const finalized = await deps.repository.transaction(async () => {
          const current = await deps.repository.lockForFinalize(raw.owner.projectId, raw.intakeId);
          if (current.state === "finalized") return current;
          const persisted = await deps.content.persist({
            reservation: current,
            actorUserId: raw.actorUserId,
            mimeType,
            bytes: raw.bytes,
            storageUrl: current.storageUrl,
          });
          if (!persisted.ok) throw Object.assign(new Error("upload persistence failed"), persisted);
          return deps.repository.finalize(raw.owner.projectId, raw.intakeId);
        });
        return {
          ok: true,
          value: {
            documentId: finalized.documentId,
            uri: finalized.canonicalUri,
            fileType: finalized.fileType,
            locationRevision: finalized.locationRevision,
          },
        };
      } catch (cause) {
        const definite =
          typeof cause === "object" && cause !== null && "definite" in cause
            ? cause.definite === true
            : false;
        if (storedThisAttempt && definite) {
          await cleanupObject(
            deps.objectStore,
            deps.eventSink,
            reservation.objectKey,
            reservation.documentId,
          );
          await deps.repository.resetObjectStored(raw.owner.projectId, raw.intakeId);
        } else if (!definite) {
          emitEvent(deps.eventSink, {
            level: "warn",
            source: "context.upload-intake",
            name: "recovery.required",
            payload: { documentId: reservation.documentId, intakeId: reservation.intakeId },
          });
        }
        return { ok: false, error: { code: "storage_failed" } };
      }
    },
    async deleteDraft(input, actorUserId) {
      const deleted = await deps.repository.deleteDraft(input, actorUserId);
      if (deleted.objectKey) {
        await cleanupObject(deps.objectStore, deps.eventSink, deleted.objectKey, input.documentId);
      }
      return deleted.result;
    },
    consume: (documentIds) => deps.repository.consume(documentIds),
  };
}
