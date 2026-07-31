/** Delete one thread-attached upload through its authoritative ContextPort location. */

import type { ThreadRepositories } from "../../threads/index.js";
import { contextPortForThread, resolveThreadContext } from "../context-port-resolution.js";
import type { ContextError } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { ThreadUploadDocumentStore } from "./thread-upload-documents.js";

export type DeleteThreadUploadResult =
  | { ok: true }
  | { ok: false; error: { code: "not_found" } }
  | { ok: false; error: { code: "context_error"; context: ContextError } };

export async function deleteThreadUpload(
  deps: {
    repos: ThreadRepositories;
    contextPorts: UnifiedContextPortFactory;
    uploadDocuments: ThreadUploadDocumentStore;
  },
  input: { threadId: string; documentId: string; userId: string },
): Promise<DeleteThreadUploadResult> {
  const resolution = await resolveThreadContext(
    { threads: deps.repos.threads, threadWorks: deps.repos.threadWorks },
    input.threadId,
  );
  if (!resolution) return { ok: false, error: { code: "not_found" } };

  const attached = await deps.uploadDocuments.getUpload(input.threadId, input.documentId);
  if (!attached) return { ok: false, error: { code: "not_found" } };
  const document = await deps.uploadDocuments.getDocument(input.documentId);
  if (!document?.uploadUri || document.projectId !== resolution.thread.projectId) {
    return { ok: false, error: { code: "not_found" } };
  }

  const deleted = await contextPortForThread(deps.contextPorts, resolution).delete(
    document.uploadUri,
    { origin: { type: "human", userId: input.userId, threadId: input.threadId } },
  );
  return deleted.ok
    ? { ok: true }
    : { ok: false, error: { code: "context_error", context: deleted.error } };
}
