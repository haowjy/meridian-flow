/** The chat's own copy of each picture a writer sends: made at admission, released with the thread. */
import { createHash, randomUUID } from "node:crypto";
import type { UploadIdentityPort } from "../../domains/context/index.js";
import type { ChatMediaPort } from "../../domains/runtime/index.js";
import type { ObjectStorePort } from "../../domains/storage/index.js";
import {
  chatMediaPrefix,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
} from "../../domains/storage/index.js";

export function createChatMedia(deps: {
  identities: UploadIdentityPort;
  objects: Pick<ObjectStorePort, "get" | "put" | "copy">;
}): ChatMediaPort {
  return {
    async keep(threadId, documentId) {
      const identity = await deps.identities.lookupDocument(documentId);
      const originalKey = identity?.storageUrl && objectStoreKeyFromStorageUrl(identity.storageUrl);
      if (!identity || !originalKey || identity.sizeBytes === null) return null;
      const object = await deps.objects.get(originalKey, { maxBytes: identity.sizeBytes });
      if (!object.ok) return null;
      const key = `${chatMediaPrefix(threadId)}${randomUUID()}`;
      const put = await deps.objects.put(key, object.value.bytes, object.value.mimeType);
      if (!put.ok) return null;
      if (identity.hasPreview) {
        // A picture the models can't take as it is reads through its preview, so a copy without it is no copy.
        const preview = await deps.objects.copy(
          previewObjectKey(originalKey),
          previewObjectKey(key),
        );
        if (!preview.ok) return null;
      }
      return { key, sha256: createHash("sha256").update(object.value.bytes).digest("hex") };
    },
  };
}
