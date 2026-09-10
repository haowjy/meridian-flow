/** F4 identity-backed late image byte adapter. */
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { ImageAssetPort } from "../ports/image-asset.js";

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
      if (available?.kind !== "available" || available.entry.uri !== reference.uri) return null;
      const identity = await deps.identities.lookupDocument(reference.documentId);
      const mediaType = identity?.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (
        !identity ||
        !mediaType.startsWith("image/") ||
        !identity.storageUrl ||
        (identity.sizeBytes ?? 0) > options.maxBytes
      )
        return null;
      const key = objectStoreKeyFromStorageUrl(identity.storageUrl);
      if (!key) return null;
      const object = await deps.objects.get(key);
      if (!object.ok || object.value.bytes.byteLength > options.maxBytes) return null;
      const actualType = object.value.mimeType.split(";")[0]?.trim().toLowerCase();
      if (actualType !== mediaType) return null;
      return {
        mediaType,
        data: Buffer.from(object.value.bytes).toString("base64"),
        sizeBytes: object.value.bytes.byteLength,
      };
    },
  };
}
