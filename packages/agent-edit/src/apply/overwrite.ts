// Whole-document overwrite: the correspondence a `create` with overwrite=true resolves, and its
// lowering for hosts that bind a whole-document write ahead of applying it.
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
import { type SemanticEditIRV1, validateSemanticEditIRV1 } from "../semantic-edit-ir.js";
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

export type LoweredOverwrite =
  | {
      ok: true;
      /** The certified intent of the change; null when nothing changed or the document was empty. */
      ir: SemanticEditIRV1 | null;
    }
  | { ok: false; code: string; message: string };

/**
 * Lower an overwrite of `doc` with nodes the host already assigned (contract
 * §6.2): the same correspondence and IR a `create` with overwrite=true
 * computes, so certified provenance can be written against the result. An
 * empty document takes the nodes as a plain insertion.
 */
export function lowerOverwrite(input: {
  doc: Y.Doc;
  model: AgentEditModel;
  codec: AgentEditCodec;
  documentId: string;
  /** Source of `blocks`, for the semantic IR only; never reparsed. */
  content: string;
  blocks: readonly Block[];
  origin?: ApplyTransactionOrigin;
}): LoweredOverwrite {
  const handle = toDocHandle(input.doc);
  if (input.model.getBlocks(handle).length === 0) {
    if (input.blocks.length > 0) {
      input.doc.transact(() => {
        input.model.insertBlocks(handle, null, { blocks: [...input.blocks] });
      }, input.origin);
    }
    return { ok: true, ir: null };
  }
  const resolved = resolveOverwrite(
    { doc: handle, model: input.model, codec: input.codec, links: "preassigned" },
    { documentId: input.documentId, filePath: "document.md" },
    { content: input.content, parsedContent: { blocks: [...input.blocks] } },
    input.blocks.length === 0,
  );
  if (!resolved.ok) return { ok: false, ...resolved.error };
  if (resolved.edits.length === 0) return { ok: true, ir: null };
  const applied = applyEdits(handle, input.model, resolved.edits, input.origin);
  if (!applied.ok) return { ok: false, ...applied.error };
  return { ok: true, ir: resolved.ir };
}
