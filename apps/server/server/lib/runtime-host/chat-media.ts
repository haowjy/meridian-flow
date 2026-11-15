/** The chat's own copy of each file it is sent as media: made when sent, released with the thread. */
import { randomUUID } from "node:crypto";
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
      const key = `${chatMediaPrefix(threadId)}${randomUUID()}`;
      // A picture the models can't take as it is reads through its preview, so a copy without it is no copy.
      const copied = await deps.objects.copy(originalKey, key);
      const previewCopied =
        copied.ok && image && identity.hasPreview
          ? await deps.objects.copy(previewObjectKey(originalKey), previewObjectKey(key))
          : copied;
      if (!previewCopied.ok)
        throw new MediaResolutionError(`The chat's copy failed: ${previewCopied.error.code}`);
      return {
        mediaType: mediaType as string,
        sizeBytes: identity.sizeBytes,
        name: identity.name,
        chatCopy: { key },
      };
    },
  };
}
