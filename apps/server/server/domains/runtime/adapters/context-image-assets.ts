/** F4 identity-backed late image byte adapter. */
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { ImageAssetPort } from "../ports/image-asset.js";

export class ImageAssetResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageAssetResolutionError";
  }
}

export function createContextImageAssetPort(deps: {
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
      const resolution = await deps.availability.lookup(
        { projectId: context.projectId as never, documentIds: [reference.documentId as never] },
        { userId: context.actorUserId },
      );
      const available = resolution.resolutions[0];
      if (available?.kind === "deleted") return null;
      if (available?.kind !== "available" || available.entry.uri !== reference.uri)
        throw new ImageAssetResolutionError(
          `Image asset is not currently resolvable: ${reference.uri}`,
        );
      const identity = await deps.identities.lookupDocument(reference.documentId);
      if (!identity) return null;
      const mediaType = identity?.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (
        !mediaType.startsWith("image/") ||
        !identity.storageUrl ||
        (identity.sizeBytes ?? 0) > options.maxBytes
      ) {
        if ((identity.sizeBytes ?? 0) > options.maxBytes) return null;
        throw new ImageAssetResolutionError(`Image asset identity is invalid: ${reference.uri}`);
      }
      const key = objectStoreKeyFromStorageUrl(identity.storageUrl);
      if (!key) throw new ImageAssetResolutionError(`Image asset key is invalid: ${reference.uri}`);
      const object = await deps.objects.get(key);
      if (!object.ok) {
        if (object.error.code === "not_found") return null;
        throw new ImageAssetResolutionError(
          `Could not resolve image asset ${reference.uri}: ${object.error.message}`,
        );
      }
      if (object.value.bytes.byteLength > options.maxBytes) return null;
      const actualType = object.value.mimeType.split(";")[0]?.trim().toLowerCase();
      if (actualType !== mediaType)
        throw new ImageAssetResolutionError(`Image asset type changed: ${reference.uri}`);
      return {
        mediaType,
        data: Buffer.from(object.value.bytes).toString("base64"),
        sizeBytes: object.value.bytes.byteLength,
      };
    },
  };
}
