import { canonicalContextUri } from "@meridian/contracts/context-uri";
import { classifyFiletype } from "@meridian/contracts/protocol";
import type { BoundWrite } from "../../collab/index.js";
import { keptFileName } from "../../file-intake/index.js";
import { projectBrowseContextUri } from "../browse-layer-scheme.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type {
  PlacedUpload,
  UploadContentPort,
  UploadReservation,
  UploadSourceDestination,
} from "./upload-intake.js";

type BoundUpload = BoundWrite | null;

export function createContextUploadContentPort(
  contextPorts: UnifiedContextPortFactory,
): UploadContentPort<BoundUpload> {
  /**
   * A source upload goes through the port the route resolved for the host's scope. A chat upload
   * goes through the chat's own port, written at the chat-relative `uploads://name`: a New-chat
   * upload has no handle yet, and the write must not depend on one.
   */
  function portFor(
    reservation: Pick<UploadReservation, "projectId" | "owner">,
    actorUserId: string,
    source?: UploadSourceDestination,
  ): ContextPort {
    if (source) return source.port;
    if (reservation.owner.kind !== "chat") throw new Error("A chat upload needs its chat");
    return contextPorts.forProject(reservation.projectId, actorUserId, new Map(), undefined, {
      chatId: reservation.owner.chatId,
      chatRef: null,
    });
  }

  const writeUri = (reservation: PlacedUpload, source?: UploadSourceDestination) =>
    source
      ? projectBrowseContextUri(source.scheme, reservation.finalPath, source.authority)
      : canonicalContextUri("uploads", reservation.finalPath, { kind: "contextual" });

  const isTracked = (reservation: PlacedUpload) =>
    classifyFiletype(reservation.fileType).kind === "tracked";

  return {
    async bind({ reservation, actorUserId, text, source }) {
      if (!isTracked(reservation) || text.length === 0) return { ok: true, bound: null };
      const port = portFor(reservation, actorUserId, source);
      const bound = await port.bindTrackedDocument(writeUri(reservation, source), text);
      return bound.ok ? { ok: true, bound: bound.value } : { ok: false };
    },

    async persist(input) {
      const { source } = input;
      const uri = writeUri(input.reservation, source);
      const port = portFor(input.reservation, input.actorUserId, source);
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
          ? await port.createBoundDocument(uri, input.bound, {
              documentId: input.reservation.documentId,
              origin,
            })
          : await port.writeBinary(uri, {
              documentId: input.reservation.documentId,
              fileType: classification.kind === "unknown" ? "binary" : classification.fileType,
              storageUrl: input.storageUrl ?? "",
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              hasPreview: input.hasPreview,
              ...(input.keptAsFile || source
                ? { filename: keptFileName(input.reservation.finalPath.split("/").pop() ?? "") }
                : {}),
              origin,
            });
      if (!result.ok || result.value.documentId !== input.reservation.documentId)
        return { ok: false };
      const { finalPath } = input.reservation;
      const leaf = result.value.uri.slice(result.value.uri.lastIndexOf("/") + 1);
      return { ok: true, finalPath: finalPath.slice(0, finalPath.lastIndexOf("/") + 1) + leaf };
    },
  };
}
