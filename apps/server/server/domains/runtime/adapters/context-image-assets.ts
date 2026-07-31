/** Image-asset adapter over context document metadata, thread attachments, and object storage. */

import { parseContextUri } from "@meridian/contracts/context-uri";
import type { PersistedImageReference } from "@meridian/contracts/threads";
import type { ThreadUploadDocumentStore } from "../../context/index.js";
import type { FigureDocumentRepository } from "../../context/ports/figure-document-repository.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type {
  ImageAssetContext,
  ImageAssetPort,
  ResolvedImageAsset,
} from "../ports/image-asset.js";

interface ImageStorageRecord {
  mediaType: string;
  storageUrl: string;
}

export interface ContextImageAssetAdapterDeps {
  figures: FigureDocumentRepository;
  uploads: ThreadUploadDocumentStore;
  objectStore: ObjectStorePort;
}

function imageMediaType(value: string | null | undefined): string | null {
  const normalized = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") ? normalized : null;
}

async function findImageStorage(
  deps: ContextImageAssetAdapterDeps,
  context: ImageAssetContext,
  reference: PersistedImageReference,
): Promise<ImageStorageRecord | null> {
  const parsed = parseContextUri(reference.uri);
  if (!parsed.ok) return null;

  if (parsed.value.scheme === "manuscript" && parsed.value.path.startsWith("assets/")) {
    const document = await deps.figures.findManuscriptAssetForProject(
      context.projectId,
      reference.documentId,
    );
    const mediaType = imageMediaType(document?.mimeType);
    return document && mediaType && document.assetPath === parsed.value.path
      ? { mediaType, storageUrl: document.storageUrl }
      : null;
  }

  if (parsed.value.scheme !== "uploads") return null;
  const attached = await deps.uploads.getUpload(context.threadId, reference.documentId);
  if (!attached) return null;
  const document = await deps.uploads.getDocument(reference.documentId);
  const mediaType = imageMediaType(document?.mimeType);
  return document?.storageUrl && mediaType ? { mediaType, storageUrl: document.storageUrl } : null;
}

export function createContextImageAssetAdapter(deps: ContextImageAssetAdapterDeps): ImageAssetPort {
  return {
    async isValidReference(context, reference) {
      return (await findImageStorage(deps, context, reference)) !== null;
    },

    async resolve(context, reference): Promise<ResolvedImageAsset | null> {
      try {
        const image = await findImageStorage(deps, context, reference);
        if (!image) return null;
        const key = objectStoreKeyFromStorageUrl(image.storageUrl);
        if (!key) return null;
        const object = await deps.objectStore.get(key);
        if (!object.ok || imageMediaType(object.value.mimeType) !== image.mediaType) return null;
        return {
          mediaType: image.mediaType,
          data: Buffer.from(object.value.bytes).toString("base64"),
        };
      } catch {
        return null;
      }
    },
  };
}
