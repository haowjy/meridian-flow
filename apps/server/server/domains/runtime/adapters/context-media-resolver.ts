/** The media resolver for Meridian Flow: file identity and access from the project, bytes or links from the object store. */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { PREVIEW_MIME_TYPE } from "../../file-intake/image-preview.js";
import { type FileAccess, isFileAccessDenied } from "../../file-policy/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { objectStoreKeyFromStorageUrl, previewObjectKey } from "../../storage/index.js";
import { linkExpirySeconds } from "../loop/media-link-window.js";
import {
  type LinkWindow,
  MediaResolutionError,
  type MediaResolverPort,
  type ResolvedMedia,
} from "../ports/media-resolver.js";

/** The image types every wire takes as they are; any other image is sent as its preview. */
const UNIVERSAL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function createContextMediaResolver(deps: {
  /** The writer's read grant on each file a prompt carries (file-access §4). */
  fileAccess: Pick<FileAccess, "authorize">;
  identities: UploadIdentityPort;
  availability: ProjectContextAvailabilityPort;
  objects: ObjectStorePort;
  eventSink: EventSink;
}): MediaResolverPort {
  /** Null: the object is gone or not what the record says; that file is unavailable, not the turn. */
  async function bytesSource(key: string, mediaType: string, sizeBytes: number) {
    const object = await deps.objects.get(key, { maxBytes: sizeBytes });
    if (!object.ok) return null;
    if (object.value.mimeType.split(";")[0]?.trim().toLowerCase() !== mediaType) return null;
    return { data: Buffer.from(object.value.bytes).toString("base64") };
  }

  async function linkOrBytes(
    key: string,
    mediaType: string,
    sizeBytes: number,
    window: LinkWindow,
  ) {
    const link = await deps.objects.getProviderReadLink(key, {
      signedAt: new Date(window.startMs),
      expiresInSeconds: linkExpirySeconds(window),
    });
    if (!link.ok) return null;
    return link.value === null ? bytesSource(key, mediaType, sizeBytes) : { url: link.value };
  }

  return {
    diagnose(input) {
      emitEvent(deps.eventSink, {
        level: "info",
        source: "runtime.media-resolver",
        name: "media.omitted",
        correlation: { threadId: input.threadId },
        payload: { projectId: input.projectId, reason: input.reason },
      });
    },
    async resolve(context, reference, window) {
      try {
        const placed = await deps.availability.placed(
          { projectId: context.projectId as never, documentIds: [reference.documentId] },
          { userId: context.actorUserId },
        );
        if (placed.inconsistent.has(reference.documentId))
          throw new MediaResolutionError(`Media resolution is indeterminate: ${reference.uri}`);
        if (!placed.documents.has(reference.documentId)) return null;
        // The path is not checked: a moved or renamed file is the same document, and the read
        // grant below decides.
        const grant = await deps.fileAccess.authorize(
          { accountId: context.actorUserId as UserId },
          { kind: "document", documentId: reference.documentId as DocumentId },
          "read",
        );
        if (isFileAccessDenied(grant)) return null;
        const identity = await deps.identities.lookupDocument(reference.documentId);
        if (!identity) return null;
        const mediaType = identity.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
        const isImage = mediaType.startsWith("image/");
        if ((!isImage && mediaType !== "application/pdf") || !identity.storageUrl) return null;
        if (identity.sizeBytes === null) return null;
        const originalKey = objectStoreKeyFromStorageUrl(identity.storageUrl);
        if (!originalKey) return null;
        const originalSize = identity.sizeBytes;

        let preview: ResolvedMedia["preview"];
        const previewKey = previewObjectKey(originalKey);
        if (isImage && !UNIVERSAL_IMAGE_TYPES.has(mediaType) && identity.hasPreview) {
          const head = await deps.objects.readHead(previewKey, 0);
          if (head.ok) preview = { mediaType: PREVIEW_MIME_TYPE, sizeBytes: head.value.sizeBytes };
          else if (head.error.code !== "not_found") return null;
        }

        return {
          mediaType,
          sizeBytes: originalSize,
          name: identity.name,
          ...(preview ? { preview } : {}),
          source: (variant, transport) => {
            const [key, type, size] =
              variant === "preview" && preview
                ? [previewKey, preview.mediaType, preview.sizeBytes]
                : [originalKey, mediaType, originalSize];
            return transport === "link"
              ? linkOrBytes(key, type, size, window)
              : bytesSource(key, type, size);
          },
        };
      } catch (error) {
        if (error instanceof MediaResolutionError) throw error;
        throw new MediaResolutionError("Media resolution failed", { cause: error });
      }
    },
  };
}
