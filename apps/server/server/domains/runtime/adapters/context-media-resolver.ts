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
  async function bytesSource(key: string, mediaType: string, sizeBytes: number, uri: string) {
    const object = await deps.objects.get(key, { maxBytes: sizeBytes });
    if (!object.ok) {
      throw new MediaResolutionError(`Could not read media ${uri}: ${object.error.message}`);
    }
    if (object.value.mimeType.split(";")[0]?.trim().toLowerCase() !== mediaType) {
      throw new MediaResolutionError(`Stored media ${uri} is not of type ${mediaType}`);
    }
    return { data: Buffer.from(object.value.bytes).toString("base64") };
  }

  async function linkOrBytes(
    key: string,
    mediaType: string,
    sizeBytes: number,
    uri: string,
    window: LinkWindow,
  ) {
    const link = await deps.objects.getProviderReadLink(key, {
      signedAt: new Date(window.startMs),
      expiresInSeconds: linkExpirySeconds(window),
    });
    if (!link.ok)
      throw new MediaResolutionError(`Could not link media ${uri}: ${link.error.message}`);
    return link.value === null ? bytesSource(key, mediaType, sizeBytes, uri) : { url: link.value };
  }

  return {
    diagnose(input) {
      emitEvent(deps.eventSink, {
        level: "info",
        source: "runtime.media-resolver",
        name: "image.omitted",
        correlation: { threadId: input.threadId },
        payload: { projectId: input.projectId, reason: input.reason },
      });
    },
    async resolve(context, reference, window) {
      try {
        const resolution = await deps.availability.lookup(
          { projectId: context.projectId as never, documentIds: [reference.documentId as never] },
          { userId: context.actorUserId },
        );
        const available = resolution.resolutions[0];
        if (available?.kind === "indeterminate")
          throw new MediaResolutionError(`Media resolution is indeterminate: ${reference.uri}`);
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
          else if (head.error.code !== "not_found") {
            throw new MediaResolutionError(
              `Could not stat preview of ${reference.uri}: ${head.error.message}`,
            );
          }
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
              ? linkOrBytes(key, type, size, reference.uri, window)
              : bytesSource(key, type, size, reference.uri);
          },
        };
      } catch (error) {
        if (error instanceof MediaResolutionError) throw error;
        throw new MediaResolutionError("Media resolution failed", { cause: error });
      }
    },
  };
}
