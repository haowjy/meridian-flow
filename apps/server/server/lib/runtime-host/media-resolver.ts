import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type {
  ProjectContextAvailabilityPort,
  UploadIdentityPort,
} from "../../domains/context/index.js";
import { PREVIEW_MIME_TYPE } from "../../domains/file-intake/image-preview.js";
import { type FileAccess, isFileAccessDenied } from "../../domains/file-policy/index.js";
import { type EventSink, emitEvent } from "../../domains/observability/index.js";
import {
  type LinkWindow,
  linkExpirySeconds,
  MediaResolutionError,
  type MediaResolverPort,
  type ResolvedMedia,
} from "../../domains/runtime/index.js";
import type { ObjectStorePort } from "../../domains/storage/index.js";
import { objectStoreKeyFromStorageUrl, previewObjectKey } from "../../domains/storage/index.js";

const UNIVERSAL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function createContextMediaResolver(deps: {
  fileAccess: Pick<FileAccess, "authorize">;
  identities: UploadIdentityPort;
  availability: ProjectContextAvailabilityPort;
  objects: ObjectStorePort;
  eventSink: EventSink;
}): MediaResolverPort {
  function missingOrFault(error: { code: string; message?: string }): null {
    if (error.code === "not_found") return null;
    throw new MediaResolutionError(`Media storage failed: ${error.code}`);
  }

  async function bytesSource(key: string, mediaType: string, sizeBytes: number) {
    const object = await deps.objects.get(key, { maxBytes: sizeBytes });
    if (!object.ok) return missingOrFault(object.error);
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
    if (!link.ok) return missingOrFault(link.error);
    return link.value === null ? bytesSource(key, mediaType, sizeBytes) : { url: link.value };
  }

  async function resolvedMedia(file: {
    key: string;
    mediaType: string;
    sizeBytes: number;
    name: string;
    mayHavePreview: boolean;
    window: LinkWindow;
  }): Promise<ResolvedMedia> {
    const previewKey = previewObjectKey(file.key);
    let preview: ResolvedMedia["preview"];
    if (file.mayHavePreview) {
      const head = await deps.objects.readHead(previewKey, 0);
      if (head.ok) preview = { mediaType: PREVIEW_MIME_TYPE, sizeBytes: head.value.sizeBytes };
      else missingOrFault(head.error);
    }
    return {
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      name: file.name,
      ...(preview ? { preview } : {}),
      source: (variant, transport) => {
        const [key, type, size] =
          variant === "preview" && preview
            ? [previewKey, preview.mediaType, preview.sizeBytes]
            : [file.key, file.mediaType, file.sizeBytes];
        return transport === "link"
          ? linkOrBytes(key, type, size, file.window)
          : bytesSource(key, type, size);
      },
    };
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
    async resolve(context, part, window) {
      try {
        const reference = part.ref;
        if (part.chatCopy) {
          const mediaType = part.mediaType;
          return resolvedMedia({
            key: part.chatCopy.key,
            mediaType,
            sizeBytes: part.sizeBytes,
            name: part.name,
            mayHavePreview: mediaType.startsWith("image/") && !UNIVERSAL_IMAGE_TYPES.has(mediaType),
            window,
          });
        }
        const placed = await deps.availability.placed(
          { projectId: context.projectId as never, documentIds: [reference.documentId] },
          { userId: context.actorUserId },
        );
        if (placed.inconsistent.has(reference.documentId))
          throw new MediaResolutionError(`Media resolution is indeterminate: ${reference.uri}`);
        if (!placed.documents.has(reference.documentId)) return null;
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
        return await resolvedMedia({
          key: originalKey,
          mediaType,
          sizeBytes: identity.sizeBytes,
          name: identity.name,
          mayHavePreview: isImage && !UNIVERSAL_IMAGE_TYPES.has(mediaType) && identity.hasPreview,
          window,
        });
      } catch (error) {
        if (error instanceof MediaResolutionError) throw error;
        throw new MediaResolutionError("Media resolution failed", { cause: error });
      }
    },
  };
}
