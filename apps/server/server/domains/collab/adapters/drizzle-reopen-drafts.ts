/**
 * The one way a closed draft comes back: Un-Apply of an Apply whose drafted delete closed the
 * Work's drafts (a Discard closes none). It flips the row to active in the target branch, closes a newer draft of the same document, replays the Un-Applies the draft
 * waited on, and resyncs the lists.
 *
 * The replay is what keeps text from doubling or vanishing: an Un-Apply that met the draft
 * closed took its effects out of live and wrote nothing to the draft (`draft_reversed` stays
 * false). The draft's base still holds that Apply's text, and a pull after the reopen would carry
 * the Un-Apply's deletion into the draft's own text. Replaying in `unapplied_seq` order, latest
 * group first, is what the open path would have done, one Un-Apply at a time.
 *
 * The caller holds the Work's lock, the target branch, the lists' keys and the keys of these
 * drafts' documents, in that order (`collab/.context/CONTEXT.md`).
 */
import {
  addCounts,
  contentMerge,
  type RuleCounts,
  ruleCounter,
} from "@meridian/agent-edit/content-merge";
import {
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  removeApplyRecords,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { BranchId, CommandId, DocumentId, DraftOwner } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { applyCommandEffects, documentDrafts } from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type * as Y from "yjs";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import { treeListOfNode } from "./drizzle-branch-tree-lists.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { effectBases } from "./drizzle-unapply-read.js";

const schema = buildDocumentSchema();

/** One Apply's effects on one draft that an Un-Apply takes out of the draft's base. */
export type BaseReversal = {
  applyCommandId: string;
  /** Every group the Un-Apply took back, those with no live write included. */
  groupIds: ReadonlySet<string>;
  /** The groups with a live write, oldest first: their text is merged out of the base. */
  merges: { baseBefore: unknown[]; baseAfter: unknown[] }[];
};

/**
 * Takes each Un-Apply's text out of the draft's base and its Apply records out of the draft, in
 * one transaction of the prefix. The one body for Un-Apply of an open draft and for a reopen's
 * replay: the base is merge input, so two copies would let them drift. Returns the rows to append.
 */
export function reverseBaseHalf(
  prefix: Y.Doc,
  reversals: readonly BaseReversal[],
): { rows: Uint8Array[]; rules: RuleCounts; overrode: number } {
  let row: Uint8Array | undefined;
  const capture = (bytes: Uint8Array) => {
    row = bytes;
  };
  const total = ruleCounter();
  let overrode = 0;
  prefix.on("update", capture);
  try {
    prefix.transact(() => {
      const fragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
      let current = readBlocks(fragment, schema);
      for (const reversal of reversals) {
        for (const effect of [...reversal.merges].reverse()) {
          const merge = contentMerge(
            schema,
            effect.baseAfter.map((node) => schema.nodeFromJSON(node)),
            current,
            effect.baseBefore.map((node) => schema.nodeFromJSON(node)),
          );
          addCounts(total.fire, merge.rules);
          overrode += merge.overrode;
          current = merge.blocks;
        }
      }
      writeBlocks(fragment, schema, current);
      for (const reversal of reversals)
        removeApplyRecords(prefix, reversal.applyCommandId, reversal.groupIds);
    }, "unapply");
  } finally {
    prefix.off("update", capture);
  }
  if (!row && reversals.length > 0) throw new Error("Un-Apply must remove its Apply records");
  return { rows: row ? [row] : [], rules: total.counts, overrode };
}

export type ReopenDrafts = ReturnType<typeof createReopenDrafts>;

export function createReopenDrafts(
  db: Database,
  deps: {
    coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
    close: Pick<DraftClose, "closeDrafts">;
    treeLists: Pick<TreeListStore, "resync">;
    workProjection: Pick<WorkProjectionMutation, "draftMembershipChanged">;
    /** Live text written while the draft was closed has not reached its base. */
    scheduleLivePull(documentId: DocumentId): void;
  },
) {
  return {
    /** The drafts `command` closed on `branchId` that are still closed and in its entry. */
    async closedBy(command: CommandId, branchId: BranchId) {
      return currentDrizzleDb(db)
        .select({ draftId: documentDrafts.id, documentId: documentDrafts.documentId })
        .from(documentDrafts)
        .where(and(eq(documentDrafts.closedBy, command), eq(documentDrafts.branchId, branchId)));
    },

    async reopen(input: {
      drafts: readonly { draftId: string; documentId: string }[];
      target: BranchId;
      /** The command that reopens: a newer draft it swaps out is closed under this id. */
      commandId: CommandId;
      owner: DraftOwner;
    }): Promise<{
      /** The documents whose draft came back. */
      reopened: string[];
    }> {
      const tx = currentDrizzleDb(db);
      const { target, commandId } = input;
      // Draft rows lock in id order: two reopens of overlapping drafts cannot deadlock.
      const ordered = [...input.drafts].sort((a, b) => a.draftId.localeCompare(b.draftId));
      const drafts = ordered;
      for (const draft of drafts) {
        const [newer] = await tx
          .select({ id: documentDrafts.id })
          .from(documentDrafts)
          .where(
            and(
              eq(documentDrafts.documentId, draft.documentId as never),
              eq(documentDrafts.branchId, target),
              eq(documentDrafts.kind, "work_draft"),
              eq(documentDrafts.status, "active"),
            ),
          );
        if (newer) {
          await deps.close.closeDrafts(tx, { draftIds: [newer.id] }, "edit_discarded", commandId);
        }
        // Stale `has_effect` is re-judged by the projection sweep.
        await tx
          .update(documentDrafts)
          .set({
            status: "active",
            closedCause: null,
            closedBy: null,
            branchId: target,
            hasEffect: true,
            hasEffectRevision: -1,
            updatedAt: new Date(),
            revision: sql`${documentDrafts.revision} + 1`,
          })
          .where(eq(documentDrafts.id, draft.draftId));
        deferUntilDrizzleCommit(() => deps.scheduleLivePull(draft.documentId as DocumentId));
      }
      const reopened = drafts.map((draft) => draft.documentId);
      if (drafts.length === 0) return { reopened };
      await replay(drafts.map((draft) => draft.draftId));
      deps.workProjection.draftMembershipChanged(input.owner);
      const lists = new Map<string, Parameters<TreeListStore["resync"]>[0][number]>();
      for (const draft of drafts) {
        const list = await treeListOfNode(db, draft.documentId);
        if (list) lists.set(JSON.stringify(list), list);
      }
      await deps.treeLists.resync([...lists.values()]);
      return { reopened };
    },
  };

  /** The Un-Applies that met this draft closed, as reversals of its base, in the order to replay. */
  async function waitingReversals(draftId: string): Promise<BaseReversal[]> {
    const tx = currentDrizzleDb(db);
    const mine = await tx
      .select({
        commandId: applyCommandEffects.commandId,
        unappliedSeq: applyCommandEffects.unappliedSeq,
        ordinal: applyCommandEffects.ordinal,
      })
      .from(applyCommandEffects)
      .where(
        and(
          eq(applyCommandEffects.draftId, draftId),
          isNotNull(applyCommandEffects.unappliedBy),
          eq(applyCommandEffects.draftReversed, false),
        ),
      );
    if (mine.length === 0) return [];
    // A group's live update builds on the earlier groups' items: within one Un-Apply the later
    // group goes first. Across Un-Applies, the order the Work lock gave them.
    const order = [...mine].sort(
      (a, b) => Number(a.unappliedSeq) - Number(b.unappliedSeq) || b.ordinal - a.ordinal,
    );
    const rows = await tx
      .select({
        commandId: applyCommandEffects.commandId,
        documentId: applyCommandEffects.documentId,
        ordinal: applyCommandEffects.ordinal,
        groupId: applyCommandEffects.groupId,
        liveDelta: applyCommandEffects.liveDelta,
        baseStart: applyCommandEffects.baseStart,
        baseDelta: applyCommandEffects.baseDelta,
      })
      .from(applyCommandEffects)
      .where(
        and(
          eq(applyCommandEffects.draftId, draftId),
          inArray(applyCommandEffects.commandId, [...new Set(order.map((row) => row.commandId))]),
        ),
      )
      .orderBy(asc(applyCommandEffects.commandId), asc(applyCommandEffects.ordinal));
    // Each Apply's base chain runs through all its rows, reversed ones included.
    const bases = new Map<string, { baseBefore: unknown[]; baseAfter: unknown[] }>();
    for (const commandId of new Set(rows.map((row) => row.commandId))) {
      const chain = effectBases(rows.filter((row) => row.commandId === commandId));
      if (!chain) throw new Error(`Apply ${commandId} stored no base start for draft ${draftId}`);
      for (const { row, baseBefore, baseAfter } of chain)
        bases.set(`${commandId}:${row.ordinal}`, { baseBefore, baseAfter });
    }
    const stored = new Map(rows.map((row) => [`${row.commandId}:${row.ordinal}`, row]));
    const reversals: BaseReversal[] = [];
    const bySeq = new Map<string, typeof order>();
    for (const row of order) {
      const key = `${row.unappliedSeq}:${row.commandId}`;
      bySeq.set(key, [...(bySeq.get(key) ?? []), row]);
    }
    for (const group of bySeq.values()) {
      const effects = group.flatMap((row) => {
        const key = `${row.commandId}:${row.ordinal}`;
        const effect = stored.get(key);
        const base = bases.get(key);
        return effect && base ? [{ effect, ...base }] : [];
      });
      reversals.push({
        applyCommandId: group[0]?.commandId as string,
        groupIds: new Set(effects.map(({ effect }) => effect.groupId)),
        // `order` is latest first within an Un-Apply; the body wants oldest first.
        merges: effects.filter(({ effect }) => effect.liveDelta !== null).reverse(),
      });
    }
    return reversals;
  }

  /** Each draft's waiting Un-Applies, applied to its base now that it is open. */
  async function replay(draftIds: readonly string[]): Promise<void> {
    const tx = currentDrizzleDb(db);
    for (const draftId of draftIds) {
      const reversals = await waitingReversals(draftId);
      if (reversals.length === 0) continue;
      const base = await deps.coordinator.loadBase(draftId);
      const write = deps.coordinator.prepareAppend(base, [], {
        work: "any",
        draft: "any",
        authorServerRows: (prefix) => reverseBaseHalf(prefix, reversals).rows,
      });
      try {
        await write.persist();
        write.transfer();
      } finally {
        write.dispose();
      }
      await tx
        .update(applyCommandEffects)
        .set({ draftReversed: true })
        .where(
          and(
            eq(applyCommandEffects.draftId, draftId),
            isNotNull(applyCommandEffects.unappliedBy),
            eq(applyCommandEffects.draftReversed, false),
          ),
        );
    }
  }
}
