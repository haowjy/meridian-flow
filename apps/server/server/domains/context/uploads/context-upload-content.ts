/** ContextFS-backed upload content adapter. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { BoundWrite } from "../../collab/index.js";
import { resolvedWorkAuthority } from "../../projects/index.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { UploadContentPort, UploadReservation } from "./upload-intake.js";

/** Tracked text bound before finalize; binary and empty uploads need nothing bound. */
type BoundUpload = BoundWrite | null;

export function createContextUploadContentPort(
  contextPorts: UnifiedContextPortFactory,
): UploadContentPort<BoundUpload> {
  function portFor(reservation: UploadReservation, actorUserId: string): ContextPort | null {
    const owner = reservation.owner;
    const workSlug = owner.workSlug === null ? null : decodeWorkSlug(owner.workSlug);
    if (owner.workSlug !== null && !workSlug) return null;
    const authority = resolvedWorkAuthority({
      workId: owner.workId as never,
      workSlug,
    });
    const authorities = authority.workSlug ? new Map([[authority.workSlug, authority]]) : new Map();
    return contextPorts.forWork(authority, reservation.projectId, actorUserId, authorities);
  }

  const isTracked = (reservation: UploadReservation) =>
    classifyFiletype(reservation.fileType).kind === "tracked";

  return {
    async bind({ reservation, actorUserId, bytes }) {
      const text = Buffer.from(bytes).toString("utf8");
      if (!isTracked(reservation) || text.length === 0) return { ok: true, bound: null };
      const port = portFor(reservation, actorUserId);
      if (!port) return { ok: false, definite: true };
      const bound = await port.bindTrackedDocument(reservation.canonicalUri, text);
      return bound.ok ? { ok: true, bound: bound.value } : { ok: false, definite: true };
    },

    async persist(input) {
      const port = portFor(input.reservation, input.actorUserId);
      if (!port) return { ok: false, definite: true };
      const origin = {
        type: "import" as const,
        userId: input.actorUserId,
        source: "upload",
        filename: input.reservation.finalPath,
        sourceId: input.reservation.intakeId,
      };
      const classification = classifyFiletype(input.reservation.fileType);
      const result =
        classification.kind === "tracked"
          ? await port.createBoundDocument(input.reservation.canonicalUri, input.bound, {
              documentId: input.reservation.documentId,
              origin,
            })
          : await port.writeBinary(input.reservation.canonicalUri, {
              documentId: input.reservation.documentId,
              fileType: classification.kind === "unknown" ? "binary" : classification.fileType,
              storageUrl: input.storageUrl ?? "",
              mimeType: input.mimeType,
              sizeBytes: input.bytes.byteLength,
              origin,
            });
      return result.ok ? { ok: true } : { ok: false, definite: true };
    },

    async remove({ reservation, actorUserId }) {
      const port = portFor(reservation, actorUserId);
      if (!port) return { ok: false, stale: true };
      const removed = await port.delete(reservation.canonicalUri, {
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
