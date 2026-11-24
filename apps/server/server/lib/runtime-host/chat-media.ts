import { createHash } from "node:crypto";
import type { UploadIdentityPort } from "../../domains/context/index.js";
import { type ChatMediaPort, MediaResolutionError } from "../../domains/runtime/index.js";
import type { ObjectStorePort } from "../../domains/storage/index.js";
import {
  chatMediaPrefix,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
} from "../../domains/storage/index.js";

export function createChatMedia(deps: {
  identities: UploadIdentityPort;
  objects: Pick<ObjectStorePort, "copy">;
}): ChatMediaPort {
  return {
    async admit(threadId, documentId) {
      const identity = await deps.identities.lookupDocument(documentId);
      const mediaType = identity?.mimeType?.split(";")[0]?.trim().toLowerCase();
      const image = mediaType?.startsWith("image/") ?? false;
      if (!identity || identity.sizeBytes === null || !(image || mediaType === "application/pdf"))
        return null;
      const originalKey = identity.storageUrl && objectStoreKeyFromStorageUrl(identity.storageUrl);
      if (!originalKey) return null;
      const source = createHash("sha256").update(originalKey).digest("hex").slice(0, 32);
      const key = `${chatMediaPrefix(threadId)}${source}`;
      const copied = await deps.objects.copy(originalKey, key);
      const previewCopied =
        copied.ok && image && identity.hasPreview
          ? await deps.objects.copy(previewObjectKey(originalKey), previewObjectKey(key))
          : copied;
      const facts = {
        mediaType: mediaType as string,
        sizeBytes: identity.sizeBytes,
        name: identity.name,
      };
      if (previewCopied.ok) return { ...facts, chatCopy: { key } };
      if (previewCopied.error.code === "not_found") return facts;
      throw new MediaResolutionError(`The chat's copy failed: ${previewCopied.error.code}`);
    },
  };
}
