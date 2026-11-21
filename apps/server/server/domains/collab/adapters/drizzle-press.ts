/**
 * The press: Apply or Discard pressed on documents, folders or a whole Work, as one
 * recorded command over both halves, and its one Undo. The tree half is the Apply's
 * (`drizzle-apply-tree.ts`) or the Discard's (`discardTreeRecords`); the text half accepts or
 * rejects the Work's suggestions in each document as one Yjs transaction on Live, whose inserted
 * and deleted id ranges are kept (`press_text_effects`). Undo is `undoApply` or `restoreDiscard`
 * for the tree, and a Yjs undo of those ranges for the text. Pressing again is the Redo.
 *
 * Lock order (`.context/CONTEXT.md`), after the command's claim: the draft's owner and the owners
 * the tree effect changes, the draft, the lists' keys, the documents' keys in id order, then writes.
 */
import {
  type PressRecord,
  pressStored,
  type UpdateJournal,
  undoPressStored,
} from "@meridian/agent-edit/integration";
import type { DocumentId, DraftId, ProjectId, UserId } from "@meridian/contracts";
import type {
  PressRequest,
  PressResult,
  PressUndoResult,
  PressVerdict,
} from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { applyCommandTrees, commands, pressTextEffects } from "@meridian/database/schema";
import {
  appliedCreates,
  descendantsOf,
  discardedBy,
  LIVE,
  madeBy,
  pendingRecords,
  restoreDiscard,
  undoApply,
} from "@meridian/project-tree";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, eq, isNull } from "drizzle-orm";
import * as Y from "yjs";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import {
  NO_OWNERS,
  type TreeJudge,
  type TreeOwners,
  withTreeOwners,
} from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { PressUnsynced, type TreeCut } from "../domain/press.js";
import { storedDocument } from "../domain/stored-document.js";
import { createApplyTreeOperations, type TreeItemFacts } from "./drizzle-apply-tree.js";
import { documentsHolding } from "./drizzle-block-text.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";

const schema = buildDocumentSchema();

export type PressCommand = {
  envelope: CommandEnvelope;
  request: Omit<PressRequest, "saw" | "seen"> & {
    saw?: TreeCut;
    /** Decoded state vectors of the pressing tab's live rooms with unacknowledged typing. */
    seen?: { documentId: string; vector: Uint8Array }[];
  };
};

export type PressUndoCommand = { envelope: CommandEnvelope; pressCommandId: string };

export type PressStore = {
  press(command: PressCommand): Promise<PressResult>;
  undo(command: PressUndoCommand): Promise<PressUndoResult>;
};

export function createDrizzlePress(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    branches: Pick<Branches, "lock">;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    arrivals?: Pick<DocumentArrivals, "settle">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    onCommitted(documentId: DocumentId): Promise<void>;
  },
): PressStore {
  const treeHalf = createApplyTreeOperations({
    db,
    treeLists: deps.treeLists,
    arrivals: deps.arrivals,
    onCommitted: deps.onCommitted,
  });

  /** The lists a Work's tree can span: its project's and the account's. */
  const listsOf = (envelope: CommandEnvelope): TreeList[] => [
    ...(envelope.projectId ? [{ kind: "project" as const, projectId: envelope.projectId }] : []),
    { kind: "account", userId: envelope.accountId },
  ];

  /**
   * Waits for the pressing tab's typing: a document whose stored state does not hold the vector
   * the tab sent answers `PressUnsynced` (503, nothing written), and the command driver resends.
   * Read after the lists' keys and before the selection: a vector held stays held, so the typing
   * it covers has moved its document's head, and the selection, read next in this transaction,
   * finds the document stale or holding the Work's change.
   */
  async function awaitSeen(seen: ReadonlyMap<string, Uint8Array>): Promise<void> {
    for (const [documentId, vector] of seen) {
      const snapshot = await deps.live.read(documentId as DocumentId);
      // A document with no stored authority (purged, never stored) has nothing to wait for.
      if (!snapshot.authority) continue;
      const doc = storedDocument(snapshot);
      try {
        if (!holds(Y.encodeStateVector(doc), vector)) throw new PressUnsynced();
      } finally {
        doc.destroy();
      }
    }
  }

  /**
   * What a press takes, read under the lists' keys: the nodes whose tree records it settles, and
   * the documents whose text it resolves. A folder takes every node under it in the Work's view,
   * and every document there has its text pressed: resolving a document with no suggestion
   * changes nothing. "all" takes every document of the Work's lists that can hold its
   * suggestions (`documentsHolding`): the pending index where it is current, and every document
   * it hasn't caught up on.
   */
  async function selection(
    envelope: CommandEnvelope,
    lists: TreeList[],
    branchId: DraftId | null,
    request: PressCommand["request"],
  ): Promise<{ tree: Set<string>; text: Set<string> }> {
    const { items } = request;
    const picked = await deps.treeLists.read({
      lists,
      view: (ends) => {
        const tree = new Set<string>();
        const text = new Set<string>();
        for (const { writer } of ends) {
          if (items === "all") {
            if (branchId)
              for (const record of pendingRecords(writer.doc, branchId)) tree.add(record.node);
            continue;
          }
          const view = writer.view(branchId ? { draft: branchId } : LIVE);
          for (const { node, half } of items) {
            const under = [
              node,
              ...(view.nodes.get(node)?.kind === "folder" ? descendantsOf(view, node) : []),
            ];
            for (const id of under) {
              tree.add(id);
              if (half !== "tree" && view.nodes.get(id)?.kind === "document") text.add(id);
            }
          }
        }
        return { tree, text };
      },
    });
    if (items === "all")
      for (const { id } of await documentsHolding(
        db,
        {
          projectId: (envelope.projectId as ProjectId | null) ?? null,
          userId: envelope.accountId as UserId,
        },
        [request.draft],
      ))
        picked.text.add(id);
    return { tree: branchId ? picked.tree : new Set(), text: picked.text };
  }

  /** Each document's place in Live after the tree half: whether its text may be written. */
  async function liveFacts(
    lists: TreeList[],
    documents: readonly string[],
    judge: TreeJudge,
  ): Promise<Map<string, Pick<TreeItemFacts, "standsInLive" | "textClosed">>> {
    return deps.treeLists.read({
      lists,
      view: (ends) => {
        const out = new Map<string, Pick<TreeItemFacts, "standsInLive" | "textClosed">>();
        for (const { writer } of ends) {
          const live = writer.view(LIVE);
          for (const id of documents) {
            const node = live.nodes.get(id);
            if (node)
              out.set(id, { standsInLive: !node.trashed, textClosed: judge.fate(node.source) });
          }
        }
        return out;
      },
    });
  }

  /**
   * One document's text half: the Work's suggestions accepted or rejected as one transaction on
   * Live, appended and recorded. The caller holds the document's key. Whether it changed anything.
   */
  async function pressText(
    envelope: CommandEnvelope,
    documentId: string,
    verdict: PressVerdict,
    draft: DraftId,
  ): Promise<boolean> {
    const snapshot = await deps.live.read(documentId as DocumentId);
    const doc = storedDocument(snapshot);
    try {
      const before = Y.encodeStateVector(doc);
      const record = pressStored(doc, schema, verdict === "apply" ? "accept" : "reject", { draft });
      if (!record || !snapshot.authority) return false;
      await deps.live.append(
        documentId as DocumentId,
        Y.encodeStateAsUpdate(doc, before),
        { seq: 0, origin: `human:${envelope.accountId}` },
        snapshot.authority,
      );
      await currentDrizzleDb(db)
        .insert(pressTextEffects)
        .values({
          commandId: envelope.commandId,
          documentId: documentId as DocumentId,
          authorityGeneration: snapshot.authority.generation,
          ...record,
        });
      delivered(documentId);
      return true;
    } finally {
      doc.destroy();
    }
  }

  function delivered(documentId: string): void {
    deferUntilDrizzleCommit(async () => {
      await deps.liveCoordinator.deliver(documentId as DocumentId);
      await deps.onCommitted(documentId as DocumentId);
    });
  }

  async function lockDocuments(documents: Iterable<string>): Promise<void> {
    const tx = currentDrizzleDb(db);
    for (const id of [...new Set(documents)].sort())
      await lockDocumentMutation(tx, id as DocumentId);
  }

  async function press(command: PressCommand): Promise<PressResult> {
    const { envelope, request } = command;
    const { draft } = request;
    const lists = listsOf(envelope);
    const seen = new Map((request.seen ?? []).map((one) => [one.documentId, one.vector]));
    const answer = (items: PressResult["items"]) => ({
      status: "pressed" as const,
      commandId: envelope.commandId,
      draft,
      verdict: request.verdict,
      items,
    });

    const run = (owners: TreeOwners) =>
      runDocumentCommand(db, envelope, () =>
        deps.workProjection.mutate(
          { branches: [draft], works: owners.works, lineages: owners.lineages },
          async (locked): Promise<PressResult> => {
            // A purged draft has no records left; its text may still hold suggestions.
            const branchId = (await deps.branches.lock(draft))?.id ?? null;
            const judge = await owners.judge(locked);
            await deps.treeLists.lock(lists);
            await awaitSeen(seen);
            const picked = await selection(envelope, lists, branchId, request);
            const nodes = [...new Set([...picked.tree, ...picked.text])];
            const tree = new Set<string>();
            const text = new Set<string>();
            if (request.verdict === "apply") {
              const listOf = await treeHalf.lockItems(nodes);
              const facts = branchId
                ? await treeHalf.apply({
                    branchId,
                    userId: envelope.accountId as UserId,
                    commandId: envelope.commandId,
                    saw: request.saw,
                    items: nodes.map((node) => ({
                      node,
                      list: listOf.get(node) ?? null,
                      tree: picked.tree.has(node),
                    })),
                    judge,
                  })
                : null;
              for (const [node, one] of facts ?? []) if (one.landed) tree.add(node);
              const standing = facts ?? (await liveFacts(lists, [...picked.text], judge));
              judge.assertLocked();
              for (const documentId of [...picked.text].sort()) {
                const one = standing.get(documentId);
                if (!one?.standsInLive || one.textClosed) continue;
                if (await pressText(envelope, documentId, "apply", draft)) text.add(documentId);
              }
            } else {
              await lockDocuments(nodes);
              if (branchId && picked.tree.size > 0) {
                const { had } = await discardTreeRecords(db, deps, {
                  branchId,
                  userId: envelope.accountId as UserId,
                  commandId: envelope.commandId,
                  ...(request.items === "all"
                    ? {}
                    : { documents: [...picked.tree] as DocumentId[] }),
                });
                for (const node of had) tree.add(node);
                if (request.items === "all") await deps.treeLists.resync(lists);
              }
              for (const documentId of [...picked.text].sort())
                if (await pressText(envelope, documentId, "discard", draft)) text.add(documentId);
            }
            return answer(
              [...new Set([...tree, ...text])].sort().map((node) => ({
                node,
                ...(tree.has(node) ? { tree: true as const } : {}),
                ...(text.has(node) ? { text: true as const } : {}),
              })),
            );
          },
        ),
      );

    if (request.verdict === "discard") return run(NO_OWNERS);
    // The sources the Work's pending records change, and where Live has the nodes they name:
    // their owners are locked with the Work's and judged under the locks. A guess read before
    // the locks, so it can miss; a miss restarts.
    const sources = () =>
      deps.treeLists.read({
        lists,
        view: (ends) => {
          const out = new Set<string>();
          for (const { writer } of ends) {
            const { changes } = writer.view({ draft });
            const live = writer.view(LIVE);
            for (const record of pendingRecords(writer.doc, draft)) {
              for (const source of changes.get(record.id)?.sources ?? []) out.add(source);
              const node = live.nodes.get(record.node);
              if (node) out.add(node.source);
            }
          }
          return out;
        },
      });
    return withTreeOwners(db, sources, run);
  }

  async function undo(command: PressUndoCommand): Promise<PressUndoResult> {
    const { envelope, pressCommandId } = command;
    const pressId = pressCommandId as PressResult["commandId"];
    const tx = () => currentDrizzleDb(db);
    const [row] = await tx()
      .select({ outcome: commands.outcome })
      .from(commands)
      .where(
        and(
          eq(commands.id, pressId),
          eq(commands.accountId, envelope.accountId),
          eq(commands.projectId, envelope.projectId as ProjectId),
          eq(commands.kind, "press"),
        ),
      );
    const pressed =
      row?.outcome.status === "done" ? (row.outcome.result as PressResult | undefined) : undefined;
    const answer = (text: string[], tree: string[]): PressUndoResult => ({
      status: "unpressed",
      commandId: envelope.commandId,
      pressCommandId: pressId,
      text: text.sort(),
      tree: tree.sort(),
    });
    // Another account's press, an unknown id, or one the day-30 purge took: nothing to take back.
    if (!pressed) return runDocumentCommand(db, envelope, async () => answer([], []));
    const lists = listsOf(envelope);
    const trees = await tx()
      .select()
      .from(applyCommandTrees)
      .where(eq(applyCommandTrees.commandId, pressId));
    const branchIds = [...new Set(trees.map((one) => one.branchId))];

    const run = (owners: TreeOwners) =>
      runDocumentCommand(db, envelope, () =>
        deps.workProjection.mutate(
          {
            branches: [pressed.draft, ...branchIds],
            works: owners.works,
            lineages: owners.lineages,
          },
          async (locked): Promise<PressUndoResult> => {
            const judge = await owners.judge(locked);
            const by = `user:${envelope.accountId}`;
            const tree = new Set<string>();
            const treeTouched = pressed.items.some((item) => item.tree);
            // A Discard's records come back as pending copies on its draft; a purged one takes none.
            const target =
              pressed.verdict === "discard" && treeTouched
                ? await deps.branches.lock(pressed.draft)
                : null;
            await deps.treeLists.lock(lists);
            const effects = await tx()
              .select()
              .from(pressTextEffects)
              .where(
                and(eq(pressTextEffects.commandId, pressId), isNull(pressTextEffects.undoneBy)),
              );
            const created = await deps.treeLists.read({
              lists,
              view: (ends) => ends.flatMap(({ writer }) => appliedCreates(writer, pressId)),
            });
            await lockDocuments([
              ...effects.map((effect) => effect.documentId),
              ...pressed.items.filter((item) => item.tree).map((item) => item.node),
            ]);
            if (treeTouched)
              await deps.treeLists.submit({
                lists,
                make: (ends) => {
                  for (const [at, { writer }] of ends.entries()) {
                    if (pressed.verdict === "discard") {
                      if (!target || !discardedBy(writer.doc, pressId).records.length) continue;
                      const restored = restoreDiscard(
                        writer,
                        pressId,
                        by,
                        target.id,
                        envelope.commandId,
                      );
                      if (restored !== "already")
                        for (const copy of restored.copies) tree.add(copy.node);
                      continue;
                    }
                    const scope = lists[at]?.kind;
                    const one = trees.find((candidate) => candidate.scope === scope);
                    if (!one) continue;
                    // A document the press created stays in Live (gate 3): the writer deletes it.
                    const result = undoApply(writer, pressId, by, envelope.commandId, {
                      writtenSince: new Set(created),
                      closed: judge.closed,
                    });
                    for (const record of result.undone) tree.add(record.node);
                  }
                },
              });
            const standing = await liveFacts(
              lists,
              effects.map((effect) => effect.documentId),
              judge,
            );
            judge.assertLocked();
            const text: string[] = [];
            for (const effect of effects.sort((a, b) => a.documentId.localeCompare(b.documentId))) {
              // A closed owner's notes take no change: the text stays as the press left it, and
              // the effect is taken back all the same, so a later Undo can't reach it.
              if (!standing.get(effect.documentId)?.textClosed && (await undoText(effect)))
                text.push(effect.documentId);
              await tx()
                .update(pressTextEffects)
                .set({ undoneBy: envelope.commandId })
                .where(
                  and(
                    eq(pressTextEffects.commandId, pressId),
                    eq(pressTextEffects.documentId, effect.documentId),
                  ),
                );
            }
            return answer(text, [...tree]);
          },
          { requireActive: false },
        ),
      );

    if (pressed.verdict === "discard") return run(NO_OWNERS);
    // The sources the press's copies changed and where Live has their nodes and its documents.
    const sources = () =>
      deps.treeLists.read({
        lists,
        view: (ends) => {
          const out = new Set<string>();
          for (const { writer } of ends) {
            const live = writer.view(LIVE);
            for (const record of madeBy(writer.doc, pressId)) {
              for (const source of live.changes.get(record.id)?.sources ?? []) out.add(source);
              const node = live.nodes.get(record.node);
              if (node) out.add(node.source);
            }
            for (const item of pressed.items) {
              const node = live.nodes.get(item.node);
              if (node) out.add(node.source);
            }
          }
          return out;
        },
      });
    return withTreeOwners(db, sources, run);
  }

  /** One document's text back as before the press: a Yjs undo of its ranges, appended. */
  async function undoText(effect: typeof pressTextEffects.$inferSelect): Promise<boolean> {
    const snapshot = await deps.live.read(effect.documentId);
    // A version restore since replaced the document: the press's ranges no longer describe it.
    if (!snapshot.authority || snapshot.authority.generation !== effect.authorityGeneration)
      return false;
    const doc = storedDocument(snapshot);
    try {
      const before = Y.encodeStateVector(doc);
      const record: PressRecord = { insertions: effect.insertions, deletions: effect.deletions };
      if (!undoPressStored(doc, record)) return false;
      await deps.live.append(
        effect.documentId,
        Y.encodeStateAsUpdate(doc, before),
        { seq: 0, origin: "system" },
        snapshot.authority,
      );
      delivered(effect.documentId);
      return true;
    } finally {
      doc.destroy();
    }
  }

  return { press, undo };
}

/** Whether a document's state vector holds everything `seen` names. */
function holds(state: Uint8Array, seen: Uint8Array): boolean {
  const have = Y.decodeStateVector(state);
  for (const [client, clock] of Y.decodeStateVector(seen))
    if ((have.get(client) ?? 0) < clock) return false;
  return true;
}
