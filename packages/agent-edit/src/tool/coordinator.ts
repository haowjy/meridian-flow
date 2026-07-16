// Wraps live-document coordinator access with write-tool error translation.
import type * as Y from "yjs";

import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
import { documentNotFound, type InternalWriteResult } from "./internal-result.js";
import type { WriteCommand } from "./types.js";

export type LiveDocumentCallback<T> = (
  doc: Y.Doc,
) => Promise<T | InternalWriteResult | null> | T | InternalWriteResult | null;

export async function withLiveDocument<T>(
  coordinator: DocumentCoordinator,
  docId: string,
  commandName: WriteCommand["command"],
  filePath: string,
  fn: LiveDocumentCallback<T>,
  options?: import("../ports/document-coordinator.js").DocumentLockOptions,
): Promise<T | InternalWriteResult | null> {
  let acquired = false;
  let cancelled: Error | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation!: (cause: Error) => void;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (cause: Error) => {
    if (acquired || cancelled) return;
    cancelled = cause;
    rejectCancellation(cause);
  };
  const onAbort = () => cancel(new Error(`Document lock acquisition aborted for ${docId}.`));
  if (options?.signal?.aborted) onAbort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.timeoutMs !== undefined) {
    timeout = setTimeout(
      () => cancel(new Error(`Timed out acquiring document lock for ${docId}.`)),
      options.timeoutMs,
    );
  }
  try {
    const operation = coordinator.withDocument(
      docId,
      async (doc) => {
        if (cancelled) throw cancelled;
        acquired = true;
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
        return fn(doc);
      },
      options,
    );
    return await Promise.race([operation, cancellation]);
  } catch (cause) {
    if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, filePath);
    throw cause;
  } finally {
    if (timeout) clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}
