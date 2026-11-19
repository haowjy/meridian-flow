/**
 * Whether a draft's parts were applied, and by which Apply, at a captured draft revision. Whether
 * a change of a part still waits is `draft-changes.ts`'s read of its text.
 */
import { type ApplyEntry, appliedParts, readApplyRecord } from "@meridian/agent-edit/diff";
import type * as Y from "yjs";
import { assertReadableDraft, type DraftSnapshot, materializeDraftRead } from "./draft-store.js";
import type { DraftDispositionStore, DraftReceiptPart } from "./ports/draft-disposition-store.js";

export type PartDisposition = "applied" | "pending" | "discarded";
/**
 * The writer's apply or discard of a part, if they made one. It outranks whatever the kernel
 * says about the part's text (a sibling change applied, or the writer typed over it).
 */
export const settledCause = (disposition: PartDisposition) =>
  disposition === "applied" || disposition === "discarded" ? disposition : null;
export interface DraftDispositionView {
  draft: DraftSnapshot;
  /**
   * `pending`: the part's draft is open and no Apply took it. `appliedBy`: the Apply command that
   * took an applied part, which its Un-Apply takes back.
   */
  parts: readonly (DraftReceiptPart & {
    disposition: PartDisposition;
    appliedBy?: string;
  })[];
}

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
        parts: cut.parts.map((part) => ({ ...part, disposition: "discarded" })),
      };
    }
    assertReadableDraft(draft);
    const doc = materializeDraftRead(cut.draft);
    try {
      const applyRecord = readApplyRecord(doc);
      const applied = appliedParts(doc, cut.parts, applyRecord);
      const by = appliedByCommand(doc, cut.parts, applyRecord, applied);
      return {
        draft,
        parts: cut.parts.map((part, index) => ({
          ...part,
          ...(by[index] ? { appliedBy: by[index] } : {}),
          disposition: applied[index]
            ? "applied"
            : draft.status === "active"
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
