/** ContextFS-backed upload content adapter. */
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import { classifyFiletype } from "@meridian/contracts/protocol";
import type { BoundWrite } from "../../collab/index.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { UploadContentPort, UploadReservation } from "./upload-intake.js";

/** Tracked text bound before finalize; binary and empty uploads need nothing bound. */
type BoundUpload = BoundWrite | null;

export function createContextUploadContentPort(
  contextPorts: UnifiedContextPortFactory,
): UploadContentPort<BoundUpload> {
  /**
   * The chat's own port, written at the chat-relative `uploads://name`: a New-chat upload has no
   * handle yet, and the write must not depend on one.
   */
  function portFor(reservation: UploadReservation, actorUserId: string): ContextPort {
    return contextPorts.forProject(reservation.projectId, actorUserId, new Map(), undefined, {
      chatId: reservation.owner.chatId,
      chatRef: null,
    });
  }

  const writeUri = (reservation: UploadReservation) =>
    canonicalContextUri("uploads", reservation.finalPath, { kind: "contextual" });

  const isTracked = (reservation: UploadReservation) =>
    classifyFiletype(reservation.fileType).kind === "tracked";

  return {
    async bind({ reservation, actorUserId, bytes }) {
      const text = Buffer.from(bytes).toString("utf8");
      if (!isTracked(reservation) || text.length === 0) return { ok: true, bound: null };
      const port = portFor(reservation, actorUserId);
      const bound = await port.bindTrackedDocument(writeUri(reservation), text);
      return bound.ok ? { ok: true, bound: bound.value } : { ok: false, definite: true };
    },

    async persist(input) {
      const port = portFor(input.reservation, input.actorUserId);
      const origin = {
        type: "import" as const,
        userId: input.actorUserId,
        source: "upload",
        filename: input.reservation.filename,
        sourceId: input.reservation.intakeId,
      };
      const classification = classifyFiletype(input.reservation.fileType);
      const result =
        classification.kind === "tracked"
          ? await port.createBoundDocument(writeUri(input.reservation), input.bound, {
              documentId: input.reservation.documentId,
              origin,
            })
          : await port.writeBinary(writeUri(input.reservation), {
              documentId: input.reservation.documentId,
              fileType: classification.kind === "unknown" ? "binary" : classification.fileType,
              storageUrl: input.storageUrl ?? "",
              mimeType: input.mimeType,
              sizeBytes: input.bytes.byteLength,
              origin,
            });
      return result.ok &&
        result.value.uri === writeUri(input.reservation) &&
        result.value.documentId === input.reservation.documentId
        ? { ok: true }
        : { ok: false, definite: true };
    },

    async remove({ reservation, actorUserId }) {
      const port = portFor(reservation, actorUserId);
      const removed = await port.delete(writeUri(reservation), {
        expected: { kind: "file", documentId: reservation.documentId },
      });
      if (removed.ok) return { ok: true };
      if (STALE_DELETE.has(removed.error.code)) return { ok: false, stale: true };
      throw new Error(`Upload ${reservation.intakeId} deletion failed: ${removed.error.code}`);
    },
  };
}

/** The upload moved or left its URI: the writer's identity no longer names a file there. */
const STALE_DELETE = new Set(["not_found", "stale_source", "stale_target", "operation_mismatch"]);
