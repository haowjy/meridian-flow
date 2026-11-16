/** One text-derived review and disposition view for every receipt at a captured draft revision. */
import {
  type ApplyEntry,
  appliedParts,
  type ChangeClassification,
  classifyChanges,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  type ReviewProjection,
  readApplyRecord,
  readBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { assertReadableDraft, type DraftSnapshot, materializeDraftRead } from "./draft-store.js";
import type {
  DraftDispositionStore,
  DraftProvenance,
  DraftReceiptPart,
} from "./ports/draft-disposition-store.js";

export type PartDisposition = "applied" | "pending" | "discarded";
/**
 * The writer's apply or discard of a part, if they made one. It outranks whatever the kernel
 * says about the part's text (a sibling change applied, or the writer typed over it).
 */
export const settledCause = (disposition: PartDisposition) =>
  disposition === "applied" || disposition === "discarded" ? disposition : null;
export interface DraftDispositionView {
  draft: DraftSnapshot;
  /** Released creation bytes have no snapshot, Apply record or projection. */
  provenance: DraftProvenance | null;
  projection: ReviewProjection | null;
  classifications: ReadonlyMap<string, ChangeClassification>;
  applyRecord: readonly ApplyEntry[];
  /**
   * `waiting`: the part is a member of a change that waits in an open draft. `appliedBy`: the
   * Apply command that took an applied part, which its Un-Apply takes back.
   */
  parts: readonly (DraftReceiptPart & {
    disposition: PartDisposition;
    waiting: boolean;
    appliedBy?: string;
  })[];
}

const schema = buildDocumentSchema();

export function createDraftDispositionReader(store: DraftDispositionStore) {
  return async (draftId: string): Promise<DraftDispositionView | null> => {
    const cut = await store.capture(draftId);
    if (!cut) return null;
    const draft = cut.draft.documentDraft;
    if (!cut.draft.checkpoint) {
      // Only a terminal released creation may have no bytes; never manufacture an empty draft.
      if (draft.status !== "closed" || !cut.contentReleased || cut.draft.tail.length)
        throw new Error(`Missing draft checkpoint: ${draftId}`);
      return {
        draft,
        provenance: null,
        projection: null,
        classifications: new Map(),
        applyRecord: [],
        parts: cut.parts.map((part) => ({ ...part, disposition: "discarded", waiting: false })),
      };
    }
    assertReadableDraft(draft);
    const doc = materializeDraftRead(cut.draft);
    try {
      const applyRecord = readApplyRecord(doc);
      const applied = appliedParts(doc, cut.parts, applyRecord);
      const by = appliedByCommand(doc, cut.parts, applyRecord, applied);
      const parts = cut.parts.map((part, index) => ({
        ...part,
        status: applied[index] ? ("applied" as const) : ("pending" as const),
      }));
      const provenance: DraftProvenance = {
        snapshot: Y.snapshot(doc),
        userId: cut.userId,
        parts,
      };
      const projection = projectReview(
        diffBlocks(
          readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
          readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
        ),
      );
      const classifications = classifyChanges(doc, projection, provenance, { record: true });
      const pending = new Set<number>();
      for (const change of classifications.values())
        for (const member of change.members) pending.add(member);
      return {
        draft,
        provenance,
        projection,
        classifications,
        applyRecord,
        parts: parts.map((part, index) => ({
          ...part,
          ...(by[index] ? { appliedBy: by[index] } : {}),
          waiting: part.status !== "applied" && draft.status === "active" && pending.has(index),
          disposition:
            part.status === "applied"
              ? "applied"
              : draft.status === "active" && pending.has(index)
                ? "pending"
                : "discarded",
        })),
      };
    } finally {
      doc.destroy();
    }
  };
}

/**
 * The Apply command that took each applied part, read from that command's own entries of the Apply
 * record; the later command when two did.
 */
function appliedByCommand(
  doc: Y.Doc,
  parts: Parameters<typeof appliedParts>[1],
  record: readonly ApplyEntry[],
  applied: readonly boolean[],
): (string | undefined)[] {
  const by: (string | undefined)[] = parts.map(() => undefined);
  if (!applied.some(Boolean)) return by;
  const commands = new Map<string, ApplyEntry[]>();
  for (const entry of record)
    if (entry.commandId)
      commands.set(entry.commandId, [...(commands.get(entry.commandId) ?? []), entry]);
  for (const [command, entries] of commands)
    appliedParts(doc, parts, entries).forEach((took, index) => {
      if (took && applied[index]) by[index] = command;
    });
  return by;
}
