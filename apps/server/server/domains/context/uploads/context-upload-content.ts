/** ContextFS-backed upload content adapter. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { PreparedWrite } from "../../collab/index.js";
import { resolvedWorkAuthority } from "../../projects/index.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { UploadContentPort, UploadReservation } from "./upload-intake.js";

/** Tracked text prepared before finalize; binary and empty uploads need nothing prepared. */
type PreparedUpload = PreparedWrite | null;

export function createContextUploadContentPort(
  contextPorts: UnifiedContextPortFactory,
): UploadContentPort<PreparedUpload> {
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
    async prepare({ reservation, actorUserId, bytes }) {
      const text = Buffer.from(bytes).toString("utf8");
      if (!isTracked(reservation) || text.length === 0) return { ok: true, prepared: null };
      const port = portFor(reservation, actorUserId);
      if (!port) return { ok: false, definite: true };
      const prepared = await port.prepareTrackedDocument(reservation.canonicalUri, text);
      return prepared.ok ? { ok: true, prepared: prepared.value } : { ok: false, definite: true };
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
          ? await port.createTrackedDocument(input.reservation.canonicalUri, input.prepared ?? "", {
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
  };
}
