/**
 * The press: Apply or Discard pressed on documents, folders or a whole Work, as one
 * recorded command, and its one Undo. While drafts are off a press has only its tree half: the
 * Apply's (`drizzle-apply-tree.ts`) or the Discard's (`discardTreeRecords`); Undo is `undoApply`
 * or `restoreDiscard`. Pressing again is the Redo. Phase 2 gives it a text half on the Work's
 * forks.
 *
 * Lock order (`.context/CONTEXT.md`), after the command's claim: the draft's owner and the owners
 * the tree effect changes, the draft, the lists' keys, the documents' keys in id order, then writes.
 */
import type { DocumentId, DraftId, ProjectId, UserId } from "@meridian/contracts";
import type { PressRequest, PressResult, PressUndoResult } from "@meridian/contracts/drafts";
import type { Database } from "@meridian/database";
import { applyCommandTrees, commands } from "@meridian/database/schema";
import {
  descendantsOf,
  LIVE,
  madeBy,
  pendingRecords,
  restoreDiscard,
  undoApply,
} from "@meridian/project-tree";
import { and, eq } from "drizzle-orm";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { NO_OWNERS, type TreeOwners, withTreeOwners } from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Drafts } from "../domain/drafts.js";
import type { TreeCut } from "../domain/press.js";
import { createApplyTreeOperations } from "./drizzle-apply-tree.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";
import type { UsageEvents } from "./usage-events.js";

export type PressCommand = {
  envelope: CommandEnvelope;
  request: Omit<PressRequest, "saw"> & { saw?: TreeCut };
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
    drafts: Pick<Drafts, "lock">;
    arrivals?: Pick<DocumentArrivals, "settle">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    onCommitted(documentId: DocumentId): Promise<void>;
    usage?: Pick<UsageEvents, "pressUndone">;
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
   * What a press takes, read under the lists' keys: the nodes whose tree records it settles. A
   * folder takes every node under it in the Work's view; "all" takes every pending record.
   */
  async function selection(
    lists: TreeList[],
    draftId: DraftId | null,
    request: PressCommand["request"],
  ): Promise<Set<string>> {
    if (!draftId) return new Set();
    const { items } = request;
    return deps.treeLists.read({
      lists,
      view: (ends) => {
        const tree = new Set<string>();
        for (const { writer } of ends) {
          if (items === "all") {
            for (const record of pendingRecords(writer.doc, draftId)) tree.add(record.node);
            continue;
          }
          const view = writer.view({ draft: draftId });
          for (const { node } of items) {
            tree.add(node);
            if (view.nodes.get(node)?.kind === "folder")
              for (const id of descendantsOf(view, node)) tree.add(id);
          }
        }
        return tree;
      },
    });
  }

  async function lockDocuments(documents: Iterable<string>): Promise<void> {
    const tx = currentDrizzleDb(db);
    for (const id of [...new Set(documents)].sort())
      await lockDocumentMutation(tx, id as DocumentId);
  }

  /** A press this account made in this project, as it answered: null for an unknown or purged id. */
  async function storedPress(
    envelope: CommandEnvelope,
    id: string,
  ): Promise<{ result: PressResult; pressedAt: Date } | null> {
    const [row] = await currentDrizzleDb(db)
      .select({ outcome: commands.outcome, pressedAt: commands.createdAt })
      .from(commands)
      .where(
        and(
          eq(commands.id, id as PressResult["commandId"]),
          eq(commands.accountId, envelope.accountId),
          eq(commands.projectId, envelope.projectId as ProjectId),
          eq(commands.kind, "press"),
        ),
      );
    return row?.outcome.status === "done" && row.outcome.result
      ? { result: row.outcome.result as PressResult, pressedAt: row.pressedAt }
      : null;
  }

  async function press(command: PressCommand): Promise<PressResult> {
    const { envelope, request } = command;
    const { draft } = request;
    const lists = listsOf(envelope);
    const answer = (items: PressResult["items"], trashed: string[] = []): PressResult => ({
      status: "pressed" as const,
      commandId: envelope.commandId,
      draft,
      verdict: request.verdict,
      items,
      ...(trashed.length > 0 ? { trashed } : {}),
    });

    const run = (owners: TreeOwners) =>
      runDocumentCommand(db, envelope, () =>
        deps.workProjection.mutate(
          { drafts: [draft], works: owners.works, lineages: owners.lineages },
          async (locked): Promise<PressResult> => {
            // A purged draft has no records left.
            const draftId = (await deps.drafts.lock(draft))?.id ?? null;
            const judge = await owners.judge(locked);
            await deps.treeLists.lock(lists);
            const picked = await selection(lists, draftId, request);
            const nodes = [...picked];
            const tree = new Set<string>();
            const trashed: string[] = [];
            if (request.verdict === "apply") {
              const listOf = await treeHalf.lockItems(nodes);
              const landed = draftId
                ? await treeHalf.apply({
                    draftId,
                    userId: envelope.accountId as UserId,
                    commandId: envelope.commandId,
                    saw: request.saw,
                    items: nodes.map((node) => ({
                      node,
                      list: listOf.get(node) ?? null,
                      tree: true,
                    })),
                    judge,
                  })
                : null;
              for (const node of landed ?? []) tree.add(node);
              judge.assertLocked();
            } else {
              await lockDocuments(nodes);
              if (draftId && picked.size > 0) {
                const discarded = await discardTreeRecords(db, deps, {
                  draftId,
                  userId: envelope.accountId as UserId,
                  commandId: envelope.commandId,
                  trash: true,
                  ...(request.items === "all" ? {} : { documents: nodes as DocumentId[] }),
                });
                for (const node of discarded.had) tree.add(node);
                trashed.push(...discarded.trashed);
                if (request.items === "all") await deps.treeLists.resync(lists);
              }
            }
            return answer(
              [...tree].sort().map((node) => ({ node, tree: true as const })),
              trashed,
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
    const stored = await storedPress(envelope, pressId);
    const pressed = stored?.result;
    const answer = (tree: string[]): PressUndoResult => ({
      status: "unpressed",
      commandId: envelope.commandId,
      pressCommandId: pressId,
      tree: tree.sort(),
    });
    // Another account's press, an unknown id, or one the day-30 purge took: nothing to take back.
    if (!stored || !pressed) return runDocumentCommand(db, envelope, async () => answer([]));
    const lists = listsOf(envelope);
    const trees = await tx()
      .select()
      .from(applyCommandTrees)
      .where(eq(applyCommandTrees.commandId, pressId));
    const draftIds = [...new Set(trees.map((one) => one.draftId))];

    const run = (owners: TreeOwners) =>
      runDocumentCommand(db, envelope, () =>
        deps.workProjection.mutate(
          {
            drafts: [pressed.draft, ...draftIds],
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
                ? await deps.drafts.lock(pressed.draft)
                : null;
            await deps.treeLists.lock(lists);
            await lockDocuments(pressed.items.filter((item) => item.tree).map((item) => item.node));
            if (treeTouched)
              await deps.treeLists.submit({
                lists,
                make: (ends) => {
                  for (const [at, { writer }] of ends.entries()) {
                    if (pressed.verdict === "discard") {
                      if (!target) continue;
                      const restored = restoreDiscard(
                        writer,
                        pressId,
                        by,
                        target.id,
                        envelope.commandId,
                        pressed.trashed,
                      );
                      if (restored !== "already")
                        for (const record of [...restored.copies, ...restored.back])
                          tree.add(record.node);
                      continue;
                    }
                    const scope = lists[at]?.kind;
                    const one = trees.find((candidate) => candidate.scope === scope);
                    if (!one) continue;
                    const result = undoApply(writer, pressId, by, envelope.commandId, {
                      closed: judge.closed,
                    });
                    for (const record of result.undone) tree.add(record.node);
                  }
                },
              });
            judge.assertLocked();
            deps.usage?.pressUndone({
              projectId: envelope.projectId,
              verdict: pressed.verdict,
              pressedAt: stored.pressedAt,
              documentIds: [],
            });
            return answer([...tree]);
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

  return { press, undo };
}
