// Whole-document overwrite: the correspondence a `create` with overwrite=true resolves, also
// applied directly to a host's document for a bound write that is not an actor's mutation.
import type * as Y from "yjs";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import type { DocumentAddress } from "../document-address.js";
import { type DocHandle, toDocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import {
  documentRevision,
  type ResolveWriteContext,
  type ResolveWriteParams,
  type ResolveWriteResult,
  resolveWrite,
} from "../resolver/resolve.js";
import { validateSemanticEditIRV1 } from "../semantic-edit-ir.js";
import { applyEdits } from "./apply-edits.js";
import type { ApplyTransactionOrigin } from "./types.js";

/**
 * Rewrite every block of `ctx.doc` as `written`, assigned against the blocks it
 * replaces; `empty` content removes them all. Unchanged blocks stay as they are.
 */
export function resolveOverwrite(
  ctx: ResolveWriteContext & { doc: DocHandle },
  documentAddress: DocumentAddress,
  written: Pick<ResolveWriteParams, "content" | "parsedContent" | "blocks">,
  empty: boolean,
): ResolveWriteResult {
  const blockCount = ctx.model.getBlocks(ctx.doc).length;
  const result = resolveWrite(
    ctx,
    empty
      ? { command: "remove", documentAddress, in: [1, blockCount] }
      : { command: "replace", documentAddress, ...written, in: [1, blockCount] },
  );
  if (result.ok) {
    validateSemanticEditIRV1(result.ir, {
      expectedDocumentId: documentAddress.documentId,
      expectedInputRevision: documentRevision(ctx),
    });
  }
  return result;
}

/**
 * Overwrite `doc` with nodes whose refs are already assigned (a host's bound
 * whole-document write, contract §6.2), under its owner's lock: the same
 * correspondence a `create` with overwrite=true resolves, so blocks left as
 * they were keep their items. An empty document takes the nodes as an insertion.
 */
export function overwriteWithAssigned(input: {
  doc: Y.Doc;
  model: AgentEditModel;
  codec: AgentEditCodec;
  documentId: string;
  /** Source of `blocks`, for the overwrite's semantic IR only; never reparsed. */
  content: string;
  blocks: readonly Block[];
  origin?: ApplyTransactionOrigin;
}): { ok: true } | { ok: false; code: string; message: string } {
  const handle = toDocHandle(input.doc);
  if (input.model.getBlocks(handle).length === 0) {
    if (input.blocks.length > 0) {
      input.doc.transact(() => {
        input.model.insertBlocks(handle, null, { blocks: [...input.blocks] });
      }, input.origin);
    }
    return { ok: true };
  }
  const resolved = resolveOverwrite(
    { doc: handle, model: input.model, codec: input.codec, links: "preassigned" },
    { documentId: input.documentId, filePath: "document.md" },
    { content: input.content, parsedContent: { blocks: [...input.blocks] } },
    input.blocks.length === 0,
  );
  if (!resolved.ok) return { ok: false, ...resolved.error };
  if (resolved.edits.length === 0) return { ok: true };
  const applied = applyEdits(handle, input.model, resolved.edits, input.origin);
  return applied.ok ? { ok: true } : { ok: false, ...applied.error };
}
