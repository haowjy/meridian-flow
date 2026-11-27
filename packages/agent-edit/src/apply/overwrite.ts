import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import type { DocumentAddress } from "../document-address.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import {
  type ResolveWriteContext,
  type ResolveWriteParams,
  type ResolveWriteResult,
  resolveWrite,
} from "../resolver/resolve.js";
import { applyEdits } from "./apply-edits.js";
import type { ApplyTransactionOrigin } from "./types.js";

export function resolveOverwrite(
  ctx: ResolveWriteContext & { doc: DocHandle },
  documentAddress: DocumentAddress,
  written: Pick<ResolveWriteParams, "content" | "parsedContent" | "blocks">,
  empty: boolean,
): ResolveWriteResult {
  return resolveWrite(
    ctx,
    empty
      ? { command: "remove", documentAddress, wholeDocument: true }
      : { command: "replace", documentAddress, ...written, wholeDocument: true },
  );
}

export function overwriteWithAssigned(input: {
  doc: DocHandle;
  model: AgentEditModel;
  codec: AgentEditCodec;
  documentId: string;
  content: string;
  blocks: readonly Block[];
  origin?: ApplyTransactionOrigin;
}): { ok: true } | { ok: false; code: string; message: string } {
  const handle = input.doc;
  const { model } = input;
  const current = model.getBlocks(handle);
  const blank = current.length === 1 && isBlankParagraph(model, current[0] as BlockRef);
  if (current.length === 0 || blank) {
    const only = current[0] ?? null;
    model.transact(
      handle,
      () => {
        if (input.blocks.length > 0)
          model.insertBlocks(handle, only, { blocks: [...input.blocks] });
        // A Loro document with no block reads as one unstored empty paragraph, which goes away
        // by itself once a block shows; a stored one is deleted.
        if (only && model.isLive(only) && model.getBlocks(handle).includes(only))
          model.deleteBlock(handle, only);
      },
      input.origin,
    );
    return { ok: true };
  }
  const resolved = resolveOverwrite(
    { doc: handle, model: input.model, codec: input.codec, links: "preassigned" },
    { documentId: input.documentId, filePath: "document" },
    { content: input.content, parsedContent: { blocks: [...input.blocks] } },
    input.blocks.length === 0,
  );
  if (!resolved.ok) return { ok: false, ...resolved.error };
  if (resolved.edits.length === 0) return { ok: true };
  const applied = applyEdits(handle, input.model, resolved.edits, input.origin);
  return applied.ok ? { ok: true } : { ok: false, ...applied.error };
}

function isBlankParagraph(model: AgentEditModel, block: BlockRef): boolean {
  return (
    model.getBlockType(block) === "paragraph" &&
    model.getHeadingLevel(block) === undefined &&
    model.getText(block) === ""
  );
}
