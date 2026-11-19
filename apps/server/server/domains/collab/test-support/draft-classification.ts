/** What the browser's classifier says about a draft's pending changes, and a test's Apply: an effect row that carries every change of the draft's parts. */

import { randomUUID } from "node:crypto";
import { editChanges, readDelta } from "@meridian/agent-edit/content-merge";
import {
  classifyChanges,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
} from "@meridian/agent-edit/diff";
import type { CommandId, DocumentId, UserId } from "@meridian/contracts";
import { applyCommandEffects, commands, type Database } from "@meridian/database";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { materializeDraftRead } from "../domain/draft-store.js";
import type { DraftDispositionStore } from "../domain/ports/draft-disposition-store.js";

const schema = buildDocumentSchema();

export async function classifiedDraft(store: DraftDispositionStore, draftId: string) {
  const cut = await store.capture(draftId);
  if (!cut?.draft.checkpoint) return null;
  const doc = materializeDraftRead(cut.draft);
  try {
    const applied = cut.parts.map((part) =>
      cut.applied.some((effect) => effect.carried.some(([id]) => id === part.id)),
    );
    const provenance = {
      snapshot: Y.snapshot(doc),
      userId: cut.userId,
      parts: cut.parts.map((part, index) => ({
        ...part,
        status: applied[index] ? ("applied" as const) : ("pending" as const),
      })),
    };
    const projection = projectReview(
      diffBlocks(
        readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
        readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
      ),
    );
    return {
      projection,
      provenance,
      classifications: classifyChanges(doc, projection, provenance, { record: true }),
    };
  } finally {
    doc.destroy();
  }
}

/**
 * An Apply as the card reads it: a command and its effect row, which carries every change of every
 * part the draft's receipts hold. The caller has already moved the draft's base.
 */
export async function recordApply(
  db: Database,
  input: {
    draftId: string;
    documentId: DocumentId;
    accountId: UserId;
    projectId: string;
    store: DraftDispositionStore;
  },
): Promise<string> {
  const cut = await input.store.capture(input.draftId);
  const carried = (cut?.parts ?? []).flatMap((part) =>
    part.delta
      ? editChanges(schema, readDelta(schema, part.delta)).map((_, index): [number, number] => [
          part.id,
          index,
        ])
      : [],
  );
  const commandId = randomUUID() as CommandId;
  await db.insert(commands).values({
    id: commandId,
    kind: "apply",
    accountId: input.accountId,
    projectId: input.projectId as never,
    outcome: { status: "done", result: {} },
  });
  await db.insert(applyCommandEffects).values({
    commandId,
    ordinal: 0,
    groupId: "all",
    documentId: input.documentId,
    draftId: input.draftId,
    liveDelta: null,
    baseDelta: [],
    carried,
  });
  return commandId;
}
