/** ContextFS-backed upload content adapter. */
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import { ASSETS_FOLDER, classifyFiletype } from "@meridian/contracts/protocol";
import type { BoundWrite } from "../../collab/index.js";
import { keptFileName } from "../../file-intake/index.js";
import { projectBrowseContextUri } from "../browse-layer-scheme.js";
import { contextAreaOf } from "../context/uri.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type {
  PlacedUpload,
  UploadContentPort,
  UploadReservation,
  UploadSourceDestination,
} from "./upload-intake.js";

/** Tracked text bound before finalize; binary and empty uploads need nothing bound. */
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
    async names({ reservation, actorUserId, source }) {
      const folder = source
        ? projectBrowseContextUri(source.scheme, ASSETS_FOLDER, source.authority)
        : "uploads://";
      const listing = await portFor(reservation, actorUserId, source).list(folder);
      if (!listing.ok) return new Set();
      return new Set(listing.value.entries.map((entry) => entry.uri.split("/").pop() ?? ""));
    },

    async bind({ reservation, actorUserId, text, source }) {
      if (!isTracked(reservation) || text.length === 0) return { ok: true, bound: null };
      const port = portFor(reservation, actorUserId, source);
      const bound = await port.bindTrackedDocument(writeUri(reservation, source), text);
      return bound.ok
        ? { ok: true, bound: bound.value }
        : { ok: false, conflict: bound.error.code === "conflict" };
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
      if (result.ok)
        return result.value.uri === uri && result.value.documentId === input.reservation.documentId
          ? { ok: true }
          : { ok: false, conflict: false };
      return { ok: false, conflict: result.error.code === "conflict" };
    },

    async remove({ reservation, actorUserId }) {
      const port = portFor(reservation, actorUserId);
      const removed = await port.delete(
        { kind: "file", nodeId: reservation.documentId },
        contextAreaOf(writeUri(reservation)),
      );
      if (removed.ok) return { ok: true };
      if (STALE_DELETE.has(removed.error.code)) return { ok: false, stale: true };
      throw new Error(`Upload ${reservation.intakeId} deletion failed: ${removed.error.code}`);
    },
  };
}

/** The upload moved or left its URI: the writer's identity no longer names a file there. */
const STALE_DELETE = new Set(["not_found", "stale_source", "stale_target", "command_conflict"]);
