/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around it, and
 * Work purge's disposal of a purged Work's branches (§2.6, F10).
 *
 * A Discard is one command that writes text and records what it took. The tree half is the
 * package's `discardDraft`, run through `treeListStore.submit` in each list the Work spans: the
 * Work's pending records are settled discarded with the command's id. The text half merges the
 * review base's side of the chosen changes into the draft as an append, under the draft's hold,
 * and stores the delta in `discard_command_effects`, which Restore reads. The draft stays open.
 * A drafted create is then in no view, and its document and text stay until retention purges them;
 * nothing here releases a document.
 *
 * Lock order (`collab/.context/CONTEXT.md`), after the command's claim: the Work (purge: threads,
 * then the Work), the branch, the list's lock (inside `submit`), the item documents' mutexes
 * in ID order, then draft rows as the kernel writes them.
 *
 */

import { discardChanges, type StoredDelta } from "@meridian/agent-edit/content-merge";
import {
  blocksEqual,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId, CommandId, UserId, WorkId } from "@meridian/contracts";
import type { Settlement } from "@meridian/contracts/commands";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { discardCommandEffects, documentDrafts } from "@meridian/database/schema";
import { discardDraft, newId, pendingRecords, recordsOfItem } from "@meridian/project-tree";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkBranchDisposal, WorkProjectionMutation } from "../../projects/index.js";
import { readSeen } from "../domain/apply-click.js";
import type {
  BranchDiscardStore,
  DiscardEnded,
  DiscardItem,
  DiscardKernelInput,
  DiscardKernelResult,
} from "../domain/branch-discard.js";
import type { Branches } from "../domain/branches.js";
import { draftSchema } from "../domain/draft-changes.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import { draftHoldsText } from "../domain/draft-projection.js";
import { closedOwnerBounce } from "./closed-owner-bounce.js";
import { treeListOfNode, treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { noteOf, type Settled, settlementOf } from "./drizzle-settlement-of.js";
import { writeTextAnswer } from "./drizzle-text-answer.js";

type KernelDeps = {
  close: Pick<DraftClose, "endDrafts">;
  branches: Pick<Branches, "close">;
  treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
};

/**
 * Settles the Work's pending tree records discarded, in every list it spans. With `documents`,
 * the records of those documents' items (and what stands on a node they create); without, all
 * of them. Returns the documents that had records, and the ones whose creation was discarded.
 */
export async function discardTreeRecords(
  db: Database,
  deps: Pick<KernelDeps, "treeLists">,
  input: {
    branchId: BranchId;
    userId?: UserId;
    commandId: string;
    documents?: readonly DocumentId[];
  },
): Promise<{ had: Set<DocumentId>; created: Set<DocumentId> }> {
  const had = new Set<DocumentId>();
  const created = new Set<DocumentId>();
  const by = input.userId ? `user:${input.userId}` : "system";
  const { result } = await deps.treeLists.submit({
    lists: await treeListsOfBranch(db, input.branchId),
    make: (copies) =>
      copies.flatMap(({ writer }) => {
        const pending = pendingRecords(writer.doc, input.branchId);
        const draft = writer.view({ draft: input.branchId });
        const items = input.documents;
        const only = items
          ? [...new Set(items.flatMap((id) => recordsOfItem(draft, pending, id)))]
          : pending;
        const discarded = new Set(
          discardDraft(
            writer,
            input.branchId,
            by,
            input.commandId,
            items ? only.map((r) => r.id) : undefined,
          ),
        );
        // A discarded delete had what it covered in the Work's view, not what its author saw.
        return pending
          .filter((record) => discarded.has(record.id))
          .map((record) => ({
            record,
            covered: draft.trash.find((entry) => entry.id === record.id)?.cascade ?? [],
          }));
      }),
  });
  for (const { record, covered } of result) {
    had.add(record.node as DocumentId);
    if (record.type === "create") created.add(record.node as DocumentId);
    for (const id of covered) had.add(id as DocumentId);
  }
  return { had, created };
}

/**
 * Work purge's disposal of one branch: every pending tree record of the Work is settled discarded
 * in each list, its drafts' rooms are named for retirement (the purge's cascade deletes the rows:
 * no writer is left to restore them), then the branch row closes. The caller holds the branch.
 */
async function disposeBranchLocked(
  db: Database,
  deps: KernelDeps,
  input: { branchId: BranchId },
): Promise<void> {
  await discardTreeRecords(db, deps, { ...input, commandId: newId() });
  await deps.close.endDrafts(currentDrizzleDb(db), { branchId: input.branchId });
  await deps.branches.close(input.branchId, new Date());
  // The branch ended and its drafts closed: the rows of its view go.
  await deps.treeLists.resync(await treeListsOfBranch(db, input.branchId));
}

/**
 * The branch's active text drafts on these documents, row-locked, each with its id and whether it
 * holds a change at its committed revision. The projection's `has_effect` stands in only where its
 * watermark is that revision; a lagging one never decides, the draft's text is read.
 */
async function lockActiveDrafts(
  db: Database,
  coordinator: Pick<DraftCoordinator, "loadBase">,
  branchId: BranchId,
  documentIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, { id: string; holdsText: boolean }>> {
  const rows = await currentDrizzleDb(db)
    .select({
      id: documentDrafts.id,
      documentId: documentDrafts.documentId,
      hasEffect: documentDrafts.hasEffect,
      revision: documentDrafts.revision,
      judgedAt: documentDrafts.hasEffectRevision,
    })
    .from(documentDrafts)
    .where(
      and(
        eq(documentDrafts.branchId, branchId),
        eq(documentDrafts.kind, "work_draft"),
        inArray(documentDrafts.documentId, [...documentIds]),
      ),
    )
    .orderBy(documentDrafts.id)
    .for("update");
  const out = new Map<DocumentId, { id: string; holdsText: boolean }>();
  for (const row of rows)
    out.set(row.documentId, {
      id: row.id,
      holdsText:
        row.judgedAt === row.revision
          ? row.hasEffect
          : draftHoldsText((await coordinator.loadBase(row.id)).replica.doc),
    });
  return out;
}

/**
 * What became of the selected items this Discard found nothing to take on: an Apply settled them
 * (`overtaken`, by that Apply), else an earlier Discard did, or nothing is left of them
 * (`already`). An Apply's note wins when the two halves differ, so a Discard that took nothing is
 * never reported as `already discarded` for an item an Apply landed.
 */
async function untakenNotes(
  db: Database,
  deps: KernelDeps,
  branchId: BranchId,
  nodes: readonly DocumentId[],
): Promise<Settlement[]> {
  if (nodes.length === 0) return [];
  const drafts = await currentDrizzleDb(db)
    .selectDistinctOn([documentDrafts.documentId], {
      documentId: documentDrafts.documentId,
      id: documentDrafts.id,
    })
    .from(documentDrafts)
    .where(
      and(
        eq(documentDrafts.branchId, branchId),
        eq(documentDrafts.kind, "work_draft"),
        inArray(documentDrafts.documentId, [...nodes]),
      ),
    )
    .orderBy(documentDrafts.documentId, desc(documentDrafts.createdAt));
  const draftOf = new Map(drafts.map((draft) => [draft.documentId, draft.id]));
  const found = await settlementOf(
    db,
    deps,
    branchId,
    await Promise.all(
      nodes.map(async (node) => {
        const draftId = draftOf.get(node);
        return {
          node,
          list: await treeListOfNode(db, node),
          ...(draftId ? { draftId } : {}),
        };
      }),
    ),
  );
  return nodes.map((node): Settlement => {
    const one = found.get(node);
    const evidence = [one?.tree.last, one?.text?.last].filter(
      (last): last is Settled => last != null && last.kind !== "purged",
    );
    const last = evidence.find((one) => one.kind !== "discarded") ?? evidence[0] ?? null;
    const note = noteOf(last, node, "discarded");
    // Nothing found is an item that is gone: the Discard has nothing left to take.
    return note.rule === "left_out" ? { rule: "already", state: "discarded", item: node } : note;
  });
}

export type DrizzleBranchDiscard = BranchDiscardStore & {
  /** The locked kernel: the caller holds §14's locks and proved the Work's state. */
  kernel(input: DiscardKernelInput): Promise<DiscardKernelResult>;
};

export function createDrizzleBranchDiscard(
  db: Database,
  deps: KernelDeps & {
    coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
    branches: Pick<Branches, "lockActive" | "close">;
    workProjection: Pick<WorkProjectionMutation, "mutate">;
  },
): DrizzleBranchDiscard {
  /** The Work's lists' keys, then the documents' in id order: what settlement is read under. */
  async function lockItems(branchId: BranchId, documents: readonly DocumentId[]) {
    await deps.treeLists.lock(await treeListsOfBranch(db, branchId));
    for (const id of [...documents].sort()) await lockDocumentMutation(currentDrizzleDb(db), id);
  }

  /**
   * A branch no longer active holds nothing to take: Discard all answers one `already`, and each
   * selected item what the settlement reader finds became of it.
   */
  async function inactive(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    if (input.selection.kind === "whole")
      return { closed: [], settled: [{ rule: "already", state: "discarded" }] };
    const documents = input.selection.items.map((item) => item.documentId);
    await lockItems(input.branchId, documents);
    return { closed: documents, settled: await untakenNotes(db, deps, input.branchId, documents) };
  }

  /**
   * Merges the review base's side of `text` into the draft, as an append under its row lock, and
   * records what it took. Null when the draft held none of the changes.
   */
  async function discardText(input: {
    commandId: string;
    documentId: DocumentId;
    draftId: string;
    text: "all" | readonly string[];
    seen?: DiscardItem["seen"];
  }): Promise<boolean> {
    const base = await deps.coordinator.loadBase(input.draftId);
    let taken: ReturnType<typeof discardChanges> = null;
    let holds = true;
    const write = deps.coordinator.prepareAppend(base, [], {
      work: "active",
      authorServerRows(prefix) {
        const fragment = prefix.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        const before = readBlocks(prefix.getXmlFragment(REVIEW_BASE_FRAGMENT), draftSchema);
        const text = readBlocks(fragment, draftSchema);
        taken = discardChanges(
          draftSchema,
          before,
          text,
          input.text,
          input.seen && readSeen(prefix, input.seen.snapshot, input.seen.baseViewDelta),
        );
        if (!taken) return [];
        const next = taken.text;
        holds = !blocksEqual(before, next);
        return captureMutationUpdates(prefix, () =>
          prefix.transact(() => writeBlocks(fragment, draftSchema, next)),
        );
      },
    });
    try {
      await write.persist();
      write.transfer();
    } finally {
      write.dispose();
    }
    if (!taken) return false;
    const tx = currentDrizzleDb(db);
    await tx.insert(discardCommandEffects).values({
      commandId: input.commandId as CommandId,
      documentId: input.documentId,
      draftId: input.draftId,
      delta: (taken as { delta: StoredDelta }).delta,
    });
    // A draft left with nothing to review leaves the list at this commit, not at the judgement.
    if (!holds) {
      const [row] = await tx
        .select({ revision: documentDrafts.revision })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, input.draftId));
      if (row)
        await writeTextAnswer(db, deps.treeLists, {
          draftId: input.draftId,
          revision: row.revision,
          hasEffect: false,
          hasEffectRevision: row.revision,
          textChanges: 0,
          listsHeld: true,
        });
    }
    return true;
  }

  /**
   * Discard all: every pending tree record of the Work, and the text of every draft it has. The
   * branch stays open; the drafts do too.
   */
  async function discardAll(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { branchId } = input;
    const commandId = input.commandId ?? newId();
    const documents = (
      await currentDrizzleDb(db)
        .select({ documentId: documentDrafts.documentId })
        .from(documentDrafts)
        .where(and(eq(documentDrafts.branchId, branchId), eq(documentDrafts.kind, "work_draft")))
    ).map((row) => row.documentId);
    await lockItems(branchId, documents);
    await discardTreeRecords(db, deps, { branchId, userId: input.userId, commandId });
    const drafts = await lockActiveDrafts(db, deps.coordinator, branchId, documents);
    for (const [documentId, draft] of drafts)
      await discardText({ commandId, documentId, draftId: draft.id, text: "all" });
    // The tree's rows are the ones the Work's view showed: they go with the records.
    await deps.treeLists.resync(await treeListsOfBranch(db, branchId));
    return { closed: documents, settled: [] };
  }

  async function kernel(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { branchId } = input;
    if (input.selection.kind === "whole") return discardAll(input);
    const commandId = input.commandId ?? newId();
    const { items } = input.selection;
    const documents = items.map((item) => item.documentId);
    // Before the records are written: the rows they write are the ones derivation locks under a
    // document's key.
    await lockItems(branchId, documents);
    // The Work's records on the items that ask for them settle discarded, in the list that holds
    // them. A created document is then in no view; it and its text stay until retention purges it.
    const treeDocuments = items.filter((item) => item.tree).map((item) => item.documentId);
    const { had, created } =
      treeDocuments.length > 0
        ? await discardTreeRecords(db, deps, {
            branchId,
            userId: input.userId,
            commandId,
            documents: treeDocuments,
          })
        : { had: new Set<DocumentId>(), created: new Set<DocumentId>() };
    const drafts = await lockActiveDrafts(db, deps.coordinator, branchId, documents);
    // An item with no record and no changed draft has nothing for this command to take:
    // `untaken` says what became of it.
    const closed: DocumentId[] = [];
    const untaken: DocumentId[] = [];
    for (const item of items) {
      const id = item.documentId;
      const draft = drafts.get(id);
      // A creation only the Work shows goes whole.
      const text = created.has(id) ? "all" : item.text;
      const tookText =
        text && draft
          ? await discardText({
              commandId,
              documentId: id,
              draftId: draft.id,
              text,
              ...(item.seen ? { seen: item.seen } : {}),
            })
          : false;
      if (!had.has(id) && !tookText) untaken.push(id);
      // Only a whole item leaves review; a tree-only Discard leaves a draft that holds text there.
      else if (text === "all" || (!text && !draft?.holdsText)) closed.push(id);
    }
    const settled = await untakenNotes(db, deps, branchId, untaken);
    return { closed: [...closed, ...untaken], settled };
  }

  return {
    kernel,
    async discardLocked({ kernel: input, command }) {
      const settled: { ended?: DiscardEnded } = {};
      await runDocumentCommand(
        db,
        command.envelope,
        // The branch's owner enters the Work boundary after the claim, before the branch row
        // and the list's lock.
        () =>
          deps.workProjection.mutate(
            { branches: [input.branchId] },
            async () => {
              settled.ended = (await deps.branches.lockActive(input.branchId))
                ? await kernel(input)
                : await inactive(input);
              return command.result(settled.ended);
            },
            { seam: true, requireActive: true },
          ),
        (cause) => {
          const returned = closedOwnerBounce(cause);
          if (!returned) return undefined;
          settled.ended = { returned };
          return command.result(settled.ended);
        },
      );
      // A lost claim throws; a command that returned settled one way or the other.
      if (!settled.ended) throw new Error("Discard ended without its answer");
      return settled.ended;
    },
  };
}

/**
 * Work purge's disposal (§2.6): inside purge's transaction after its deleted/cutoff proof,
 * lock each of the Work's active branches and discard each whole through the kernel. The
 * public command's active-Work fence is never used. No pending projection: the Work is being
 * deleted; its closed drafts retire after commit like any others. Its drafted creates are in
 * no view afterwards and retention purges them.
 */
export function createDrizzleWorkBranchDisposal(
  db: Database,
  deps: KernelDeps & {
    branches: Pick<Branches, "byOriginWork" | "activeByOriginLineages" | "lockActive" | "close">;
  },
): WorkBranchDisposal {
  async function dispose(
    workId: WorkId,
    lineageRootIds: readonly string[],
  ): Promise<{ releasedObjects: readonly string[] }> {
    const owned = [
      ...(await deps.branches.byOriginWork(workId)),
      ...(await deps.branches.activeByOriginLineages(lineageRootIds as ThreadId[])),
    ];
    const branchIds = owned.map((branch) => branch.id).sort();
    for (const branchId of branchIds) {
      if (await deps.branches.lockActive(branchId))
        await disposeBranchLocked(db, deps, { branchId });
    }
    return { releasedObjects: [] };
  }

  return {
    withDisposal(workId, run) {
      return run((roots) => dispose(workId, roots));
    },
  };
}
