/** The chat's own copy of each picture a writer sends: made at admission, released with the thread. */
import { randomUUID } from "node:crypto";
import type { UploadIdentityPort } from "../../domains/context/index.js";
import { type EventSink, emitEvent } from "../../domains/observability/index.js";
import type { ChatMediaPort } from "../../domains/runtime/index.js";
import type { ObjectStorePort } from "../../domains/storage/index.js";
import {
  chatMediaPrefix,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
} from "../../domains/storage/index.js";

export function createChatMedia(deps: {
  identities: UploadIdentityPort;
  objects: Pick<ObjectStorePort, "copy">;
  eventSink: EventSink;
}): ChatMediaPort {
  return {
    async admit(threadId, documentId) {
      const identity = await deps.identities.lookupDocument(documentId);
      const mediaType = identity?.mimeType?.split(";")[0]?.trim().toLowerCase();
      if (!identity || identity.sizeBytes === null || !mediaType?.startsWith("image/")) return null;
      const facts = { mediaType, sizeBytes: identity.sizeBytes, name: identity.name };
      const originalKey = identity.storageUrl && objectStoreKeyFromStorageUrl(identity.storageUrl);
      if (!originalKey) return facts;

      const key = `${chatMediaPrefix(threadId)}${randomUUID()}`;
      // A picture the models can't take as it is reads through its preview, so a copy without it is no copy.
      const copied = await deps.objects.copy(originalKey, key);
      const previewCopied =
        copied.ok && identity.hasPreview
          ? await deps.objects.copy(previewObjectKey(originalKey), previewObjectKey(key))
          : copied;
      if (previewCopied.ok) return { ...facts, chatCopy: { key } };
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "runtime.chat-media",
        name: "chat_copy.failed",
        correlation: { threadId },
        payload: { documentId, reason: previewCopied.error.code },
      });
      return facts;
    },
  };
}
