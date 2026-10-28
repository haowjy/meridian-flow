/** F4 identity-backed late image byte adapter. */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { PREVIEW_MIME_TYPE } from "../../file-intake/image-preview.js";
import { type FileAccess, isFileAccessDenied } from "../../file-policy/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { objectStoreKeyFromStorageUrl, previewObjectKey } from "../../storage/index.js";
import { type ImageAssetPort, ImageAssetResolutionError } from "../ports/image-asset.js";

/** The image types every model provider accepts; anything else is sent as its preview or left out. */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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
        if (available?.kind !== "available") return null;
        // A chat's upload is its document: the spelling moves from the bare form to the handle
        // once the chat has a row, so only its identity and the read grant below decide.
        if (available.entry.scope?.kind !== "chat" && available.entry.uri !== reference.uri)
          return null;
        const grant = await deps.fileAccess.authorize(
          { accountId: context.actorUserId as UserId },
          { kind: "document", documentId: reference.documentId as DocumentId },
          "read",
        );
        if (isFileAccessDenied(grant)) return null;
        const identity = await deps.identities.lookupDocument(reference.documentId);
        if (!identity) return null;
        const storedType = identity.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (!storedType.startsWith("image/") || !identity.storageUrl) return null;
        const originalKey = objectStoreKeyFromStorageUrl(identity.storageUrl);
        if (!originalKey) return null;
        // An image the models can't read goes as the preview the server made of it. The preview
        // is a bounded WebP, so the original's size limit does not apply to it.
        const asPreview = !MODEL_IMAGE_TYPES.has(storedType);
        if (asPreview ? !identity.hasPreview : (identity.sizeBytes ?? 0) > options.maxBytes)
          return null;
        const mediaType = asPreview ? PREVIEW_MIME_TYPE : storedType;
        const key = asPreview ? previewObjectKey(originalKey) : originalKey;
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
