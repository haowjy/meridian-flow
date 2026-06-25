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
): Promise<T | InternalWriteResult | null> {
  try {
    return await coordinator.withDocument(docId, async (doc) => fn(doc));
  } catch (cause) {
    if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, filePath);
    throw cause;
  }
}
