/**
 * Reference loading resolves the mention and calls `readDocument`, as the
 * `read` tool does (D18). Unlike a tool result, the reference block is
 * persisted by run preparation, so the read records its own evidence, and
 * only while the run that will send it is still live.
 */
import type { JsonValue } from "@meridian/contracts/threads";
import type { ReferenceReader, ShownLinkStore } from "../../domains/runtime/index.js";
import { resolveDocumentAddress } from "./document-tools.js";
import { documentGrant } from "./file-access.js";
import { readDocument } from "./read-document.js";
import { showing } from "./shown-link-capture.js";
import {
  isToolError,
  recordTouchInBackground,
  resolveToolCall,
  type ToolWiringDeps,
  writeToolError,
} from "./tool-context.js";

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

function readError(message: string, status?: "document_not_found"): JsonValue {
  return asJson(writeToolError("read", message, status).output);
}

export function createReferenceReader(
  deps: ToolWiringDeps & { shownLinks: Pick<ShownLinkStore, "record"> },
): ReferenceReader {
  return {
    async read(reference, ctx) {
      const call = await resolveToolCall(deps, ctx);
      if (isToolError(call)) return { result: readError(call.output.message), revision: null };
      const address = await resolveDocumentAddress(call.context, "read", reference.uri);
      if (isToolError(address)) return { result: asJson(address.output), revision: null };
      if (address.documentId !== reference.documentId) {
        return {
          revision: null,
          result: readError(
            "Referenced document is no longer available at this URI.",
            "document_not_found",
          ),
        };
      }
      const grant = await documentGrant(deps, call.principal, "read", address, "read");
      if (isToolError(grant)) return { result: asJson(grant.output), revision: null };
      const outcome = await readDocument(deps, grant, address, {}, ctx);
      if (!outcome.isError) {
        // The attachment's read text goes to the model as the reference block.
        if (!ctx.signal?.aborted) {
          for (const shown of showing(address.documentId, address.uri, outcome)) {
            await deps.shownLinks.record({ ...shown, threadId: ctx.threadId, turnId: ctx.turnId });
          }
        }
        recordTouchInBackground(deps, address.documentId, ctx);
      }
      return { result: asJson(outcome.result), revision: outcome.revision };
    },
  };
}
