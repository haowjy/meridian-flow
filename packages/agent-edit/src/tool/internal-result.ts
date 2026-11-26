import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Block } from "../codec-types.js";
import type { ObservationFrontier } from "../frontier.js";
import type { LinkShowing } from "../links/shown.js";
import type { AgentEditModelPayload } from "./model-result.js";
import { removedFile } from "./removal-copy.js";
import type { DocumentCommandName, WriteStatus } from "./types.js";

export type InternalWriteResult = InternalWriteResultBase & { status: WriteStatus };

interface InternalWriteResultBase {
  revision?: string | null;
  showing?: LinkShowing;
  frontier?: ObservationFrontier;
  nodes?: readonly Block[];
  aheadSettlements?: ReadonlyMap<string, string>;
  model?: AgentEditModelPayload;
  writeId?: string;
  occupied?: true;
}

export function documentNotFound(
  commandName: DocumentCommandName,
  cause?: { removal?: DocumentRemovalRecord },
): InternalWriteResult {
  if (!cause?.removal) return status("document_not_found", DOCUMENT_NOT_FOUND_MESSAGE);
  const removed = removedFile(cause.removal);
  return status(removed.status, removed.message);
}

export const DOCUMENT_NOT_FOUND_MESSAGE = "File not found.";

export function internalResultError(result: InternalWriteResult): Error {
  return new Error(
    result.model?.message ? `${result.status}: ${result.model.message}` : result.status,
  );
}

function status(code: Exclude<WriteStatus, "success">, message?: string): InternalWriteResult {
  return { status: code, ...(message ? { model: { message } } : {}) };
}
