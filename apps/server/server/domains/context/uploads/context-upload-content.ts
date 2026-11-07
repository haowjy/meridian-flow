/** ContextFS-backed upload content adapter. */
import { type ContextUriScheme, canonicalContextUri } from "@meridian/contracts/context-uri";
import { classifyFiletype, firstFreeName } from "@meridian/contracts/protocol";
import type { BoundWrite } from "../../collab/index.js";
import { keptFileName } from "../../file-intake/index.js";
import { contextAreaOf } from "../context/uri.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import {
  ASSETS_FOLDER,
  type UploadContentPort,
  type UploadReservation,
  type UploadSourceDestination,
} from "./upload-intake.js";

const MAX_NAME_COPIES = 100;

/** Tracked text bound before finalize; binary and empty uploads need nothing bound. */
type BoundUpload = BoundWrite | null;

export function createContextUploadContentPort(
  contextPorts: UnifiedContextPortFactory,
): UploadContentPort<BoundUpload> {
  /**
   * A source upload is written through the port the route resolved for the host's scope. A chat
   * upload goes through the chat's own port, at the chat-relative `uploads://name`: a New-chat
   * upload has no handle yet, and the write must not depend on one.
   */
  function portFor(
    reservation: UploadReservation,
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

  const addressOf = (scheme: ContextUriScheme, path: string) =>
    canonicalContextUri(scheme, path, { kind: "contextual" });
  const writeUri = (reservation: UploadReservation, source?: UploadSourceDestination) =>
    addressOf(source?.scheme ?? "uploads", reservation.finalPath);

  const isTracked = (reservation: UploadReservation) =>
    classifyFiletype(reservation.fileType).kind === "tracked";

  return {
    async bind({ reservation, actorUserId, text, source }) {
      if (!isTracked(reservation) || text.length === 0) return { ok: true, bound: null };
      const port = portFor(reservation, actorUserId, source);
      const bound = await port.bindTrackedDocument(writeUri(reservation, source), text);
      return bound.ok ? { ok: true, bound: bound.value } : { ok: false, definite: true };
    },

    async persist(input) {
      const { reservation, source } = input;
      const port = portFor(reservation, input.actorUserId, source);
      const origin = {
        type: "import" as const,
        userId: input.actorUserId,
        source: "upload",
        filename: reservation.filename,
        sourceId: reservation.intakeId,
      };
      const classification = classifyFiletype(reservation.fileType);
      const write = (uri: string, keptName: string) =>
        classification.kind === "tracked"
          ? port.createBoundDocument(uri, input.bound, {
              documentId: reservation.documentId,
              origin,
            })
          : port.writeBinary(uri, {
              documentId: reservation.documentId,
              fileType: classification.kind === "unknown" ? "binary" : classification.fileType,
              storageUrl: input.storageUrl ?? "",
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              hasPreview: input.hasPreview,
              ...(input.keptAsFile ? { filename: keptFileName(keptName) } : {}),
              origin,
            });
      if (!source) {
        const uri = writeUri(reservation);
        const result = await write(uri, reservation.finalPath);
        return result.ok &&
          result.value.uri === uri &&
          result.value.documentId === reservation.documentId
          ? { ok: true, finalPath: reservation.finalPath }
          : { ok: false, definite: true };
      }
      // A source upload takes its name now, not when it reserved: the same file dropped twice
      // keeps both ("map.pdf", then "map (2).pdf"), and a folder renamed meanwhile is no obstacle.
      const taken = new Set<string>();
      for (let attempt = 0; attempt < MAX_NAME_COPIES; attempt += 1) {
        const filename = firstFreeName(input.documentFilename, taken).filename;
        const path = `${ASSETS_FOLDER}/${filename}`;
        const result = await write(addressOf(source.scheme, path), filename);
        if (result.ok)
          return result.value.documentId === reservation.documentId
            ? { ok: true, finalPath: path }
            : { ok: false, definite: true };
        if (result.error.code !== "conflict") break;
        taken.add(filename);
      }
      return { ok: false, definite: true };
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
const STALE_DELETE = new Set(["not_found", "stale_source", "stale_target", "operation_mismatch"]);
