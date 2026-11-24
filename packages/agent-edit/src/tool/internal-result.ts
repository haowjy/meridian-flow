// Defines internal write-tool result envelopes beneath the public WriteOutcome API.

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
  /** Host-only: what the rendered result showed the model. */
  showing?: LinkShowing;
  /** Host-only: the frontier of what the rendered result showed, when the caller asked. */
  frontier?: ObservationFrontier;
  /** The blocks a read selected, for a host copying them. */
  nodes?: readonly Block[];
  /** Where each settled `ahead:` ref in `nodes` points, read in the same scope as `nodes`. */
  aheadSettlements?: ReadonlyMap<string, string>;
  model?: AgentEditModelPayload;
  writeId?: string;
  /** Host-only: a `create` without overwrite met a document with text; the host makes a twin. */
  occupied?: true;
}

/** A missing document; a removed one says who removed it and how. */
export function documentNotFound(
  commandName: DocumentCommandName,
  cause?: { removal?: DocumentRemovalRecord },
): InternalWriteResult {
  if (!cause?.removal) return status("document_not_found", DOCUMENT_NOT_FOUND_MESSAGE);
  const removed = removedFile(cause.removal);
  return status(removed.status, removed.message);
}

/** The one sentence every missing-document result gives the model; a removed file has its own. */
export const DOCUMENT_NOT_FOUND_MESSAGE = "File not found.";

/** An internal failure that must abort the caller, carrying the model-facing message. */
export function internalResultError(result: InternalWriteResult): Error {
  return new Error(
    result.model?.message ? `${result.status}: ${result.model.message}` : result.status,
  );
}

function status(code: Exclude<WriteStatus, "success">, message?: string): InternalWriteResult {
  return { status: code, ...(message ? { model: { message } } : {}) };
}
