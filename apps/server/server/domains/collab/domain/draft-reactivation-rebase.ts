/** Rebuilds a reactivated draft basis after accepted draft writes are undone. */
import {
  type AgentEditCodec,
  type AgentEditModel,
  fragmentOf,
  toDocHandle,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { buildLiveDocAtSeq, serializePreview } from "./draft-projection.js";
import type {
  Draft,
  DraftBasisUpdate,
  DraftClaimedMutationLease,
  DraftStore,
  DraftUpdate,
} from "./drafts.js";

export async function rebaseReactivatedDraft(input: {
  documentId: DocumentId;
  threadId: ThreadId;
  draft: Draft;
  lease: DraftClaimedMutationLease;
  originalDraftDoc: Y.Doc;
  originalUpdates: readonly DraftUpdate[];
  deps: {
    liveUpdateJournal: Parameters<typeof buildLiveDocAtSeq>[0];
    draftStore: Pick<DraftStore, "finishClaimedMutation">;
    latestLiveUpdateSeq(documentId: DocumentId): Promise<number>;
    codec: AgentEditCodec;
    model: AgentEditModel;
  };
}): Promise<void> {
  const draftIntentMarkdown = serializePreview(
    input.originalDraftDoc,
    input.deps.codec,
    input.deps.model,
  );
  const baseLiveUpdateSeq = await input.deps.latestLiveUpdateSeq(input.documentId);
  const oldDoc = await buildLiveDocAtSeq(
    input.deps.liveUpdateJournal,
    input.documentId,
    input.draft.baseLiveUpdateSeq,
  );
  const liveDoc = await buildLiveDocAtSeq(
    input.deps.liveUpdateJournal,
    input.documentId,
    baseLiveUpdateSeq,
  );
  const postUndoLiveMarkdown = serializePreview(liveDoc, input.deps.codec, input.deps.model);
  const newDoc = createCollabYDoc({ gc: false });
  const updates: DraftBasisUpdate[] = [];
  try {
    Y.applyUpdate(newDoc, Y.encodeStateAsUpdate(liveDoc));
    for (const row of input.originalUpdates) {
      const beforeRowMarkdown = serializePreview(oldDoc, input.deps.codec, input.deps.model);
      Y.applyUpdate(oldDoc, row.updateData, { type: "system" });
      const rowMarkdown = serializePreview(oldDoc, input.deps.codec, input.deps.model);
      if (rowDeltaAlreadyPresent(newDoc, beforeRowMarkdown, rowMarkdown, input.deps)) continue;
      const before = Y.encodeStateVector(newDoc);
      const beforeState = Y.encodeStateAsUpdate(newDoc);
      reapplyMarkdownDelta(newDoc, beforeRowMarkdown, rowMarkdown, input.deps);
      const afterState = Y.encodeStateAsUpdate(newDoc);
      if (equalBytes(beforeState, afterState)) continue;
      updates.push({
        updateData: Y.encodeStateAsUpdate(newDoc, before),
        actorUserId: row.actorUserId,
        actorTurnId: row.actorTurnId,
      });
    }
    const hadDraftIntentBeyondLive =
      normalizeSerializedMarkdown(draftIntentMarkdown) !==
      normalizeSerializedMarkdown(postUndoLiveMarkdown);
    if (hadDraftIntentBeyondLive && updates.length === 0) {
      throw new Error(
        `Segmented draft rebase produced an empty journal for ${input.draft.id} after reversal left live unchanged relative to draft intent`,
      );
    }
  } finally {
    oldDoc.destroy();
    liveDoc.destroy();
    newDoc.destroy();
  }
  const rebasedDraft = await input.deps.draftStore.finishClaimedMutation({
    lease: input.lease,
    targetStatus: "active",
    baseLiveUpdateSeq,
    updates,
  });
  if (!rebasedDraft) throw new Error(`Failed to rebase reactivated draft ${input.draft.id}`);
}

function reapplyMarkdownDelta(
  doc: Y.Doc,
  beforeMarkdown: string,
  afterMarkdown: string,
  deps: { codec: AgentEditCodec; model: AgentEditModel },
): void {
  const currentMarkdown = serializePreview(doc, deps.codec, deps.model);
  if (normalizeSerializedMarkdown(currentMarkdown) === normalizeSerializedMarkdown(afterMarkdown))
    return;
  if (normalizeSerializedMarkdown(beforeMarkdown) === normalizeSerializedMarkdown(afterMarkdown))
    return;
  if (normalizeSerializedMarkdown(beforeMarkdown).length === 0) {
    replaceDocMarkdown(doc, afterMarkdown, deps);
    return;
  }
  if (afterMarkdown.startsWith(beforeMarkdown)) {
    const appended = afterMarkdown.slice(beforeMarkdown.length).trim();
    if (appended.length > 0) {
      appendMarkdown(doc, appended, deps);
      return;
    }
  }
  applyBlockDelta(doc, beforeMarkdown, afterMarkdown, deps);
}

function rowDeltaAlreadyPresent(
  doc: Y.Doc,
  beforeMarkdown: string,
  afterMarkdown: string,
  deps: { codec: AgentEditCodec; model: AgentEditModel },
): boolean {
  const currentBlocks = new Set(markdownBlocks(serializePreview(doc, deps.codec, deps.model)));
  const beforeBlocks = new Set(markdownBlocks(beforeMarkdown));
  const afterBlocks = markdownBlocks(afterMarkdown);
  const addedBlocks = afterBlocks.filter((block) => !beforeBlocks.has(block));
  return addedBlocks.length > 0 && addedBlocks.every((block) => currentBlocks.has(block));
}

function applyBlockDelta(
  doc: Y.Doc,
  beforeMarkdown: string,
  afterMarkdown: string,
  deps: { codec: AgentEditCodec; model: AgentEditModel },
): void {
  const currentBlocks = markdownBlocks(serializePreview(doc, deps.codec, deps.model));
  const beforeBlocks = new Set(markdownBlocks(beforeMarkdown));
  const afterBlocks = new Set(markdownBlocks(afterMarkdown));
  const removedBlocks = new Set([...beforeBlocks].filter((block) => !afterBlocks.has(block)));
  const nextBlocks = currentBlocks.filter((block) => !removedBlocks.has(block));
  const nextBlockSet = new Set(nextBlocks);
  for (const block of afterBlocks) {
    if (!beforeBlocks.has(block) && !nextBlockSet.has(block)) {
      nextBlocks.push(block);
      nextBlockSet.add(block);
    }
  }
  replaceDocMarkdown(doc, nextBlocks.join("\n\n"), deps);
}

function appendMarkdown(
  doc: Y.Doc,
  markdown: string,
  deps: { codec: AgentEditCodec; model: AgentEditModel },
): void {
  doc.transact(
    () => {
      const blocks = deps.model.getBlocks(toDocHandle(doc));
      deps.model.insertBlocks(toDocHandle(doc), blocks.at(-1) ?? null, deps.codec.parse(markdown));
    },
    { type: "system" },
  );
}

function replaceDocMarkdown(
  doc: Y.Doc,
  markdown: string,
  deps: { codec: AgentEditCodec; model: AgentEditModel },
): void {
  const parsed = deps.codec.parse(markdown);
  doc.transact(
    () => {
      const fragment = fragmentOf(doc);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      deps.model.insertBlocks(toDocHandle(doc), null, parsed);
    },
    { type: "system" },
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeSerializedMarkdown(markdown: string): string {
  return markdown.replace(/\u00a0/g, " ").trim();
}

function markdownBlocks(markdown: string): string[] {
  return normalizeSerializedMarkdown(markdown)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}
