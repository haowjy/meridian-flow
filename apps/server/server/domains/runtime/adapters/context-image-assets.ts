/** F4 identity-backed late image byte adapter. */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { type FileAccess, isFileAccessDenied } from "../../file-policy/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import { type ImageAssetPort, ImageAssetResolutionError } from "../ports/image-asset.js";

export function createContextImageAssetPort(deps: {
  /** The writer's read grant on each image a prompt carries (file-access §4). */
  fileAccess: Pick<FileAccess, "authorize">;
  identities: UploadIdentityPort;
  availability: ProjectContextAvailabilityPort;
  objects: ObjectStorePort;
  eventSink: EventSink;
}): ImageAssetPort {
  return {
    diagnose(input) {
      try {
        emitEvent(deps.eventSink, {
          level: "info",
          source: "runtime.image-assets",
          name: "image.omitted",
          correlation: { threadId: input.threadId },
          payload: { projectId: input.projectId, reason: input.reason },
        });
      } catch {
        // Diagnostics never veto the writer's text send.
      }
    },
    async resolve(context, reference, options) {
      try {
        const resolution = await deps.availability.lookup(
          { projectId: context.projectId as never, documentIds: [reference.documentId as never] },
          { userId: context.actorUserId },
        );
        const available = resolution.resolutions[0];
        if (available?.kind === "indeterminate")
          throw new ImageAssetResolutionError(
            `Image asset resolution is indeterminate: ${reference.uri}`,
          );
        if (available?.kind !== "available" || available.entry.uri !== reference.uri) return null;
        const grant = await deps.fileAccess.authorize(
          { accountId: context.actorUserId as UserId },
          { kind: "document", documentId: reference.documentId as DocumentId },
          "read",
        );
        if (isFileAccessDenied(grant)) return null;
        const identity = await deps.identities.lookupDocument(reference.documentId);
        if (!identity) return null;
        const mediaType = identity.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (
          !mediaType.startsWith("image/") ||
          !identity.storageUrl ||
          (identity.sizeBytes ?? 0) > options.maxBytes
        ) {
          return null;
        }
        const key = objectStoreKeyFromStorageUrl(identity.storageUrl);
        if (!key) return null;
        const object = await deps.objects.get(key);
        if (!object.ok) {
          if (object.error.code === "not_found") return null;
          throw new ImageAssetResolutionError(
            `Could not resolve image asset ${reference.uri}: ${object.error.message}`,
          );
        }
        if (object.value.bytes.byteLength > options.maxBytes) return null;
        const actualType = object.value.mimeType.split(";")[0]?.trim().toLowerCase();
        if (actualType !== mediaType || !actualType.startsWith("image/")) return null;
        return {
          mediaType,
          data: Buffer.from(object.value.bytes).toString("base64"),
          sizeBytes: object.value.bytes.byteLength,
        };
      } catch (error) {
        if (error instanceof ImageAssetResolutionError) throw error;
        throw new ImageAssetResolutionError("Image asset resolution failed", { cause: error });
      }
    },
  };
}
