/** Authoritative, resumable upload intake aggregate. */
import { createHash } from "node:crypto";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import type {
  DeleteDraftUploadInput,
  DeleteDraftUploadResult,
  Filetype,
  StartUploadInput,
  UploadIntakeError,
  UploadIntakeResult,
  UploadOwner,
  UploadStart,
} from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  MAX_UPLOAD_BYTES,
  type ParsedDocumentFilename,
} from "@meridian/contracts/protocol";
import {
  classifyUpload,
  intakeFilename,
  keptFileName,
  normalizeFilename,
  normalizeMime,
  TRACKED_TEXT_MAX_BYTES,
} from "../../file-intake/index.js";

export { classifyUpload } from "../../file-intake/index.js";

import {
  needsPreviewConversion,
  PREVIEW_SOURCE_MAX_BYTES,
  saveImagePreview,
} from "../../file-intake/image-preview.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import {
  createObjectStorageUrl,
  type ObjectRelease,
  type ObjectStorePort,
} from "../../storage/index.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";

/** Bytes of the file's start that classification looks at. */
const HEAD_BYTES = 8 * 1024;

/** An upload nobody has touched for this long is dropped, objects and row. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;

/**
 * Where a browser's PUT lands. No row points at this key, so a late or repeated PUT through the
 * signed URL can only change bytes nobody has read yet; finish copies it to `objectKey` before
 * it reads anything. A bucket lifecycle rule on this prefix is the backstop for stray objects.
 */
export function incomingObjectKey(projectId: string, documentId: string): string {
  return `incoming/${projectId}/${documentId}`;
}

export type StartUploadOutcome =
  | { ok: true; value: UploadStart }
  | { ok: false; error: UploadIntakeError };

export type UploadIntakeOutcome =
  | { ok: true; value: UploadIntakeResult }
  | { ok: false; error: UploadIntakeError };

export interface UploadReservation {
  projectId: string;
  intakeId: string;
  actorUserId: string;
  documentId: string;
  fingerprint: string;
  /** The name the writer picked. */
  filename: string;
  /** The type the writer's browser declared; the signed PUT carries exactly this. */
  mimeType: string;
  /** The length the writer declared; the signed PUT carries exactly this. */
  sizeBytes: number;
  objectKey: string;
  locationRevision: string;
  state: "reserved" | "object_stored" | "finalized" | "deleted";
  /** Null while `reserved`: the name and type are chosen when the stored bytes are read. */
  fileType: Filetype | null;
  finalPath: string | null;
  canonicalUri: string | null;
  storageUrl: string | null;
  consumed: boolean;
  /** `chatRef` is null until the chat's row, and so its handle, exists. */
  owner: { kind: "chat"; chatId: string; chatRef: string | null };
}

/** A reservation whose name and type are chosen: `object_stored` or later. */
export type ClaimedUpload = UploadReservation & {
  fileType: Filetype;
  finalPath: string;
  canonicalUri: string;
};

export function claimedOf(reservation: UploadReservation): ClaimedUpload {
  const { fileType, finalPath, canonicalUri } = reservation;
  if (!fileType || !finalPath || !canonicalUri)
    throw new Error(`Upload ${reservation.intakeId} has no name yet (${reservation.state})`);
  return { ...reservation, fileType, finalPath, canonicalUri };
}

export type ReserveUploadResult =
  | { kind: "reserved" | "existing"; reservation: UploadReservation }
  | { kind: "conflict" }
  | { kind: "owner_unavailable" };

export type ClaimUploadResult =
  | { kind: "claimed" | "existing"; reservation: UploadReservation }
  | { kind: "gone" };

/** SQL lifecycle owner. Transactions must join the process ambient DB transaction. */
export interface UploadIntakeRepository {
  /** Reserves the intake with the declared name, type and size; an existing one is touched. */
  reserve(input: {
    intakeId: string;
    actorUserId: string;
    owner: UploadOwner;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    fingerprint: string;
  }): Promise<ReserveUploadResult>;
  /** The intake, if `actorUserId` made it for `chatId`. */
  readOwned(
    projectId: string,
    intakeId: string,
    actorUserId: string,
    chatId: string,
  ): Promise<UploadReservation | null>;
  /**
   * Picks the name and records the type, `reserved` to `object_stored`, in one step under the
   * source's name lock. Anything but `reserved` is returned as it stands.
   */
  claim(input: {
    projectId: string;
    intakeId: string;
    documentFilename: ParsedDocumentFilename;
    fileType: Filetype;
    storageUrl: string;
  }): Promise<ClaimUploadResult>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  lockForFinalize(projectId: string, intakeId: string): Promise<UploadReservation>;
  /** `tracked` text lives in its document, so the row stops naming an object. */
  finalize(projectId: string, intakeId: string, tracked: boolean): Promise<ClaimedUpload>;
  /** Locks and validates the exact unused identity a writer asked to delete. */
  lockForDelete(
    input: DeleteDraftUploadInput,
    actorUserId: string,
  ): Promise<
    | { kind: "claimed"; reservation: UploadReservation }
    | { kind: "refused"; result: DeleteDraftUploadResult; reservation?: UploadReservation }
  >;
  markDeleted(projectId: string, intakeId: string): Promise<void>;
  /**
   * Marks the chat's own finalized uploads among `documentIds` as used by a sent message and
   * returns the sources whose rows changed. Another chat's file named here is left alone.
   */
  consume(documentIds: readonly string[], chatId: string): Promise<string[]>;
  /** Intakes never finalized and untouched since `cutoff`, oldest first. */
  listAbandoned(
    cutoff: Date,
    limit: number,
  ): Promise<{ projectId: string; intakeId: string; documentId: string; objectKey: string }[]>;
  /** Drops one such row; false when it was touched or finished meanwhile. */
  dropAbandoned(projectId: string, intakeId: string, cutoff: Date): Promise<boolean>;
}

/**
 * ContextFS adapter seam; it is the only content/catalog mutation dependency.
 * `bind` runs before finalize's transaction opens: binding tracked text
 * assigns its link refs and may register ahead refs, which must not wait on the
 * locks finalize holds (contract §6.2). `persist` applies what it bound.
 */
export interface UploadContentPort<Bound = unknown> {
  bind(input: {
    reservation: ClaimedUpload;
    actorUserId: string;
    /** The file's text, read from the stored object; empty for anything that is not tracked text. */
    text: string;
  }): Promise<{ ok: true; bound: Bound } | { ok: false }>;
  persist(input: {
    reservation: ClaimedUpload;
    bound: Bound;
    actorUserId: string;
    mimeType: string;
    sizeBytes: number;
    storageUrl: string | null;
    /** A browser-drawable preview sits beside the stored object. */
    hasPreview: boolean;
    /** Text stored as a binary row: its name keeps the extension the port would otherwise strip. */
    keptAsFile: boolean;
  }): Promise<{ ok: true } | { ok: false }>;
  /** Soft-deletes an arrived upload; `stale` when its identity no longer stands at its URI. */
  remove(input: {
    reservation: ClaimedUpload;
    actorUserId: string;
  }): Promise<{ ok: true } | { ok: false; stale: true }>;
}

export interface UploadIntake {
  /** Reserves the upload and signs a PUT for its bytes. Calling again with the same `intakeId` resumes it. */
  start(
    input: StartUploadInput & { actorUserId: string; owner: UploadOwner },
  ): Promise<StartUploadOutcome>;
  /** Reads what the browser PUT, names the file and makes it visible. Safe to call again. */
  finish(input: {
    intakeId: string;
    actorUserId: string;
    owner: UploadOwner;
  }): Promise<UploadIntakeOutcome>;
  deleteDraft(input: DeleteDraftUploadInput, actorUserId: string): Promise<DeleteDraftUploadResult>;
  /** Runs in the sending transaction; republishes the catalog rows whose `used` it changed. */
  consume(documentIds: readonly string[], chatId: string): Promise<void>;
  /** Drops uploads untouched for a day, objects and row. Returns how many it dropped. */
  sweepAbandoned(now?: Date): Promise<number>;
}

function fingerprint(input: {
  actorUserId: string;
  owner: UploadOwner;
  filename: string;
  sizeBytes: number;
}): string {
  const owner = `chat:${input.owner.projectId}:${input.owner.chatId}`;
  return createHash("sha256")
    .update(JSON.stringify([input.actorUserId, owner, input.filename, input.sizeBytes]))
    .digest("hex");
}

const resultOf = (reservation: ClaimedUpload): UploadIntakeResult => ({
  documentId: reservation.documentId,
  uri: reservation.canonicalUri,
  fileType: reservation.fileType,
  locationRevision: reservation.locationRevision,
});

export function createUploadIntake<Bound>(deps: {
  repository: UploadIntakeRepository;
  content: UploadContentPort<Bound>;
  objectStore: ObjectStorePort;
  /** Deletes objects (and their previews) the intake no longer needs. */
  release: ObjectRelease;
  eventSink: EventSink;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
}): UploadIntake {
  const conflict = { ok: false, error: { code: "idempotency_conflict" } } as const;
  const storageFailed = { ok: false, error: { code: "storage_failed" } } as const;

  /** A finish that stops here leaves the row as it stands; the writer starts again or retries. */
  const releaseAll = (reservation: UploadReservation) =>
    deps.release.keys([
      incomingObjectKey(reservation.projectId, reservation.documentId),
      reservation.objectKey,
    ]);

  return {
    async start(raw) {
      const filename = normalizeFilename(raw.filename);
      const validation = validateContextEntryName(filename);
      if (!validation.ok) {
        return {
          ok: false,
          error: {
            code: "invalid_filename",
            reason: validation.reason,
            ...(validation.character ? { character: validation.character } : {}),
          },
        };
      }
      if (raw.sizeBytes > MAX_UPLOAD_BYTES)
        return { ok: false, error: { code: "too_large", limitBytes: MAX_UPLOAD_BYTES } };
      const { owner } = raw;
      const reserved = await deps.repository.reserve({
        intakeId: raw.intakeId,
        actorUserId: raw.actorUserId,
        owner,
        filename,
        mimeType: normalizeMime(raw.mimeType),
        sizeBytes: raw.sizeBytes,
        fingerprint: fingerprint({
          actorUserId: raw.actorUserId,
          owner,
          filename,
          sizeBytes: raw.sizeBytes,
        }),
      });
      if (reserved.kind === "conflict") return conflict;
      if (reserved.kind === "owner_unavailable")
        return { ok: false, error: { code: "owner_unavailable" } };
      const { reservation } = reserved;
      const { documentId, locationRevision } = reservation;
      switch (reservation.state) {
        case "deleted":
          return conflict;
        case "finalized":
          return {
            ok: true,
            value: { state: "finalized", result: resultOf(claimedOf(reservation)) },
          };
        case "object_stored":
          return { ok: true, value: { state: "stored", documentId, locationRevision } };
        case "reserved": {
          const put = await deps.objectStore.signPut(
            incomingObjectKey(reservation.projectId, documentId),
            { sizeBytes: reservation.sizeBytes, mimeType: reservation.mimeType },
          );
          if (!put.ok) return storageFailed;
          return {
            ok: true,
            value: { state: "reserved", documentId, locationRevision, put: put.value },
          };
        }
      }
    },

    async finish(raw) {
      const { projectId, chatId } = raw.owner;
      const read = () =>
        deps.repository.readOwned(projectId, raw.intakeId, raw.actorUserId, chatId);
      let current = await read();
      if (!current || current.state === "deleted") return conflict;
      if (current.state === "finalized") return { ok: true, value: resultOf(claimedOf(current)) };

      const incomingKey = incomingObjectKey(projectId, current.documentId);
      if (current.state === "reserved") {
        // Copy first, then read only the final key: a PUT through the signed URL after this
        // point changes the incoming object and nothing that is read.
        const copied = await deps.objectStore.copy(incomingKey, current.objectKey);
        if (!copied.ok) {
          if (copied.error.code !== "not_found") return storageFailed;
          // Another finish may have moved the intake on and removed the incoming object.
          current = await read();
          if (!current || current.state === "deleted") return conflict;
          if (current.state === "finalized")
            return { ok: true, value: resultOf(claimedOf(current)) };
          if (current.state === "reserved") return { ok: false, error: { code: "not_uploaded" } };
        }
      }

      const stored = await deps.objectStore.readHead(current.objectKey, HEAD_BYTES);
      if (!stored.ok) {
        // A delete releases the final object too, and then there is nothing to read.
        const after = stored.error.code === "not_found" ? await read() : current;
        return !after || after.state === "deleted" ? conflict : storageFailed;
      }
      if (stored.value.sizeBytes !== current.sizeBytes) {
        await releaseAll(current);
        return { ok: false, error: { code: "size_mismatch" } };
      }

      // Type and text come from the stored bytes alone. Text and convertible pictures are read
      // whole within a cap, so a NUL late in a text file and the picture preview see every byte.
      const { filename, mimeType, sizeBytes } = current;
      let fileType: Filetype;
      let whole: Buffer | null = null;
      let headWasText: boolean;
      try {
        fileType = await classifyUpload({ filename, mimeType, bytes: stored.value.head });
        headWasText = classifyFiletype(fileType).kind === "tracked";
        const readWhole = async () => {
          const got = await deps.objectStore.get(current.objectKey, { maxBytes: sizeBytes });
          if (!got.ok || got.value.bytes.byteLength !== sizeBytes)
            throw new Error("stored object could not be read whole");
          return Buffer.from(got.value.bytes);
        };
        if (headWasText && sizeBytes <= TRACKED_TEXT_MAX_BYTES) {
          whole = await readWhole();
          fileType = await classifyUpload({ filename, mimeType, bytes: whole });
        } else if (headWasText) {
          fileType = "binary";
        } else if (
          sizeBytes <= PREVIEW_SOURCE_MAX_BYTES &&
          (await needsPreviewConversion(stored.value.head))
        ) {
          whole = await readWhole();
        }
      } catch {
        return storageFailed;
      }
      const keptAsFile = headWasText && classifyFiletype(fileType).kind !== "tracked";
      const parsed = keptAsFile
        ? { ok: true as const, value: { ...keptFileName(filename), filetype: "binary" as const } }
        : intakeFilename(filename, fileType, mimeType);
      if (!parsed.ok)
        return { ok: false, error: { code: "invalid_filename", reason: "name/reserved" } };

      let claimed: ClaimedUpload;
      if (current.state === "reserved") {
        const claim = await deps.repository.claim({
          projectId,
          intakeId: raw.intakeId,
          documentFilename: parsed.value,
          fileType,
          storageUrl: createObjectStorageUrl(current.objectKey),
        });
        if (claim.kind === "gone") {
          await releaseAll(current);
          return conflict;
        }
        if (claim.reservation.state === "deleted") {
          await releaseAll(claim.reservation);
          return conflict;
        }
        if (claim.reservation.state === "finalized")
          return { ok: true, value: resultOf(claimedOf(claim.reservation)) };
        claimed = claimedOf(claim.reservation);
      } else {
        claimed = claimedOf(current);
      }

      const tracked = classifyFiletype(claimed.fileType).kind === "tracked";
      // A tracked file with bytes but no text read from them must never become an empty document.
      if (tracked && sizeBytes > 0 && !whole) return storageFailed;
      const storageUrl = claimed.storageUrl ?? createObjectStorageUrl(claimed.objectKey);
      const hasPreview =
        !tracked && whole
          ? await saveImagePreview({
              objectStore: deps.objectStore,
              storageUrl,
              bytes: whole,
              onFailure: (reason) =>
                emitEvent(deps.eventSink, {
                  level: "warn",
                  source: "context.upload-intake",
                  name: "image_preview.failed",
                  payload: { documentId: claimed.documentId, reason },
                }),
            })
          : false;

      try {
        const bound = await deps.content.bind({
          reservation: claimed,
          actorUserId: raw.actorUserId,
          text: tracked && whole ? whole.toString("utf8") : "",
        });
        if (!bound.ok) throw new Error("upload binding failed");
        const outcome = await deps.repository.transaction(async () => {
          const locked = await deps.repository.lockForFinalize(projectId, raw.intakeId);
          if (locked.state === "deleted") return { kind: "deleted" as const };
          if (locked.state === "finalized")
            return { kind: "finalized" as const, reservation: claimedOf(locked) };
          const persisted = await deps.content.persist({
            reservation: claimedOf(locked),
            bound: bound.bound,
            actorUserId: raw.actorUserId,
            mimeType,
            sizeBytes,
            storageUrl: tracked ? null : storageUrl,
            hasPreview,
            keptAsFile,
          });
          if (!persisted.ok) throw new Error("upload persistence failed");
          return {
            kind: "finalized" as const,
            reservation: await deps.repository.finalize(projectId, raw.intakeId, tracked),
          };
        });
        if (outcome.kind === "deleted") {
          await releaseAll(claimed);
          return conflict;
        }
        await deps.release.keys(tracked ? [incomingKey, claimed.objectKey] : [incomingKey]);
        return { ok: true, value: resultOf(outcome.reservation) };
      } catch {
        // Nothing is undone: the row is `object_stored` and the object is in place, so a retry
        // reclassifies from it and resumes.
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "context.upload-intake",
          name: "finish.failed",
          payload: { documentId: claimed.documentId, intakeId: claimed.intakeId },
        });
        return storageFailed;
      }
    },

    async deleteDraft(input, actorUserId) {
      const deleted = await deps.repository.transaction(async () => {
        const claim = await deps.repository.lockForDelete(input, actorUserId);
        if (claim.kind === "refused") return claim;
        const { reservation } = claim;
        // An arrived upload keeps its identity through the canonical soft delete, so a ref
        // settled to it answers gone and never captures a later upload at the same address.
        // A reservation that never finalized has no document row to remove.
        if (reservation.state === "finalized") {
          const removed = await deps.content.remove({
            reservation: claimedOf(reservation),
            actorUserId,
          });
          if (!removed.ok) return { result: { kind: "identity_mismatch" as const } };
        }
        await deps.repository.markDeleted(reservation.projectId, reservation.intakeId);
        return { result: { kind: "deleted" as const }, reservation };
      });
      // A finish that is copying or has copied still finds the row deleted and releases its own.
      if ("reservation" in deleted && deleted.reservation) await releaseAll(deleted.reservation);
      return deleted.result;
    },

    async consume(documentIds, chatId) {
      const sourceIds = await deps.repository.consume(documentIds, chatId);
      if (sourceIds.length > 0) await deps.catalog.refreshSources(sourceIds);
    },

    async sweepAbandoned(now = new Date()) {
      const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
      let dropped = 0;
      for (const row of await deps.repository.listAbandoned(cutoff, SWEEP_BATCH)) {
        await deps.release.keys([incomingObjectKey(row.projectId, row.documentId), row.objectKey]);
        if (await deps.repository.dropAbandoned(row.projectId, row.intakeId, cutoff)) dropped += 1;
      }
      return dropped;
    },
  };
}
