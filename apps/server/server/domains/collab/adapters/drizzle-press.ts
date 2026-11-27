/**
 * The press: Apply or Discard on one change, a document, a draft or every draft of a Work, as one
 * recorded command, and its one Undo (design §2). Each draft in scope is pressed in draft id order,
 * each on Live as the one before left it. Its tree half is the Apply's (`drizzle-apply-tree.ts`)
 * or the Discard's (`discardTreeRecords`); its text half runs `applyBlocks` or `discardBlocks` on
 * a command copy of each document's fork room, commits Live's room then the fork's under
 * the press (`CommitAuthor`), and stores each change's edit in `press_changes`. The Undo goes draft by draft,
 * newest first: `undoPress` from those rows, then `undoApply` or `restoreDiscard`. Pressing again
 * is the Redo.
 *
 * Lock order (`.context/CONTEXT.md`), after the command's claim: the drafts' owners and the owners
 * the tree effect changes, the drafts in id order, the lists' keys, the documents' keys in id
 * order, then writes.
 */

import { undoInRooms } from "@meridian/agent-edit/integration";
import type {
  CommandId,
  DocumentId,
  DraftId,
  ProjectId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { parseDraftItemKey } from "@meridian/contracts";
import type { PressAction, PressResult, PressUndoResult } from "@meridian/contracts/drafts";
import { type DocumentRoom, loroRoomName, parseLoroRoomName } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  applyCommandTrees,
  commands,
  documentForks,
  drafts,
  pressChanges,
} from "@meridian/database/schema";
import {
  applyBlocks,
  type ChangeSelection,
  type DocChange,
  discardBlocks,
  editSince,
  encodeChanges,
  type PressedChange,
  type RoomDocs,
  type RoomVersion,
  undoPress,
} from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import {
  discardedBy,
  LIVE,
  listRecords,
  madeBy,
  pendingRecords,
  restoreDiscard,
  undoApply,
} from "@meridian/project-tree";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { LoroDoc } from "loro-crdt";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  requireOutsideTransaction,
} from "../../../shared/drizzle-transaction.js";
import { NO_OWNERS, type TreeOwners, withTreeOwners } from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Drafts } from "../domain/drafts.js";
import type { TreeCut } from "../domain/press.js";
import { markFork } from "../rooms/postgres-document-rooms.js";
import { createApplyTreeOperations } from "./drizzle-apply-tree.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { type ReceiptWrite, recordDocumentEdit } from "./drizzle-document-edits.js";
import { treeCommand } from "./drizzle-draft-tree-lists.js";
import { type RestorePart, readRooms, restoredParts, restorePlan } from "./drizzle-turn-restore.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";
import type { UsageEvents } from "./usage-events.js";

export type PressCommand = {
  envelope: CommandEnvelope;
  request: PressAction & {
    saw?: TreeCut;
    liveVersions?: ReadonlyMap<DocumentId, RoomVersion>;
  };
};

export type PressUndoCommand = { envelope: CommandEnvelope; pressCommandId: string };

export type PressStore = {
  press(command: PressCommand): Promise<PressResult>;
  undo(command: PressUndoCommand): Promise<PressUndoResult>;
};

type DraftPart = {
  draft: DraftId;
  documents: DocumentId[] | "all";
  change: string | null;
  tree: DocumentId[] | "all";
  turn?: TurnId;
};

const ORIGIN = "server:press";

export function createDrizzlePress(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    drafts: Pick<Drafts, "lock">;
    rooms: DocumentRooms<DrizzleDb>;
    arrivals?: Pick<DocumentArrivals, "settle">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    onCommitted(documentId: DocumentId): Promise<void>;
    usage?: Pick<UsageEvents, "pressUndone">;
  },
): PressStore {
  const tx = () => currentDrizzleDb(db);
  const treeHalf = createApplyTreeOperations({
    db,
    treeLists: deps.treeLists,
    arrivals: deps.arrivals,
    onCommitted: deps.onCommitted,
  });

  const listsOf = (envelope: CommandEnvelope): TreeList[] => [
    ...(envelope.projectId ? [{ kind: "project" as const, projectId: envelope.projectId }] : []),
    { kind: "account", userId: envelope.accountId },
  ];

  async function partsOf(scope: PressAction["scope"]): Promise<DraftPart[]> {
    if (scope.kind === "turn")
      return [{ draft: scope.draft, documents: [], change: null, tree: [], turn: scope.turn }];
    if (scope.kind === "change" || scope.kind === "document") {
      const item = parseDraftItemKey(scope.item);
      if (!item) return [];
      return [
        {
          draft: item.draftId,
          documents: [item.documentId],
          change: scope.kind === "change" ? scope.change : null,
          tree: scope.kind === "change" ? [] : [item.documentId],
        },
      ];
    }
    const ids =
      scope.kind === "draft"
        ? [scope.draft]
        : (
            await tx()
              .select({ id: drafts.id })
              .from(drafts)
              .where(
                and(
                  eq(drafts.workId, scope.work as WorkId),
                  inArray(drafts.id, scope.drafts),
                  isNull(drafts.deletedAt),
                ),
              )
              .orderBy(asc(drafts.id))
          ).map((row) => row.id as DraftId);
    return ids.map((draft) => ({ draft, documents: "all", change: null, tree: "all" }));
  }

  async function textDocuments(part: DraftPart): Promise<DocumentId[]> {
    const rows = await tx()
      .select({ documentId: documentForks.documentId })
      .from(documentForks)
      .where(
        and(
          eq(documentForks.draftId, part.draft),
          part.documents === "all"
            ? eq(documentForks.pending, true)
            : inArray(documentForks.documentId, part.documents),
        ),
      );
    return rows.map((row) => row.documentId as DocumentId).sort();
  }

  async function treeNodes(lists: TreeList[], part: DraftPart): Promise<string[]> {
    if (part.tree !== "all") return part.tree;
    return deps.treeLists.read({
      lists,
      view: (ends) => {
        const out = new Set<string>();
        for (const { writer } of ends)
          for (const record of pendingRecords(writer.doc, part.draft)) out.add(record.node);
        return [...out];
      },
    });
  }

  /**
   * A loaded fork saves on a debounce, and its row (that it exists, that it is pending) is what
   * `textDocuments` reads: a tab's first words in a draft, acknowledged just before the press, are
   * in the room but not yet in a row. The press's transaction holds the locks a save takes.
   */
  async function saveLoadedForks(drafts: readonly string[]): Promise<void> {
    requireOutsideTransaction("Saving a press's loaded forks");
    for (const name of deps.rooms.loaded()) {
      const room = parseLoroRoomName(name);
      if (room?.kind === "fork" && drafts.includes(room.draftId)) await deps.rooms.flush(room);
    }
  }

  async function lockDocuments(documents: Iterable<string>): Promise<void> {
    for (const id of [...new Set(documents)].sort())
      await lockDocumentMutation(tx(), id as DocumentId);
  }

  async function commitCopy(
    room: Extract<DocumentRoom, { kind: "fork" }>,
    changes: { live: DocChange[]; fork: DocChange[] },
  ): Promise<boolean> {
    if (changes.live.length)
      await deps.rooms.commit(
        tx(),
        { kind: "live", documentId: room.documentId },
        encodeChanges(changes.live),
        ORIGIN,
      );
    if (changes.fork.length)
      await deps.rooms.commit(tx(), room, encodeChanges(changes.fork), ORIGIN);
    return changes.live.length + changes.fork.length > 0;
  }

  async function pressText(
    envelope: CommandEnvelope,
    request: PressCommand["request"],
    draft: DraftId,
    documentId: DocumentId,
    selection: ChangeSelection,
  ): Promise<boolean> {
    const room = { kind: "fork" as const, draftId: draft, documentId };
    const copy = await deps.rooms.read(room);
    try {
      const by = { press: envelope.commandId };
      const pressed =
        request.verdict === "apply"
          ? applyBlocks(copy, selection, {
              by,
              liveVersion: request.liveVersions?.get(documentId) ?? new Map(),
            })
          : discardBlocks(copy, selection, { by });
      const committed = await commitCopy(room, pressed);
      await markFork(tx(), room, copy);
      if (pressed.pressed.length)
        await tx()
          .insert(pressChanges)
          .values({
            commandId: envelope.commandId as CommandId,
            draftId: draft,
            documentId,
            changes: pressed.pressed,
          });
      return committed;
    } finally {
      copy.free();
    }
  }

  async function takeBack(
    envelope: CommandEnvelope,
    parts: readonly RestorePart[],
    turn: TurnId | null,
  ): Promise<DocumentId[]> {
    const copies = await readRooms(deps.rooms, parts);
    try {
      const rooms = new Map<string, { forward: DocChange[]; since: RoomVersion }>();
      for (const { room } of parts) {
        const name = loroRoomName(room);
        if (rooms.has(name)) continue;
        const copy = copies.get(name) as RoomDocs;
        rooms.set(name, {
          forward: copy.live ? copy.forward().restore : [],
          since: copy.shownVersion(),
        });
      }
      const undone = undoInRooms(parts, (room) => copies.get(loroRoomName(room)) as RoomDocs, {
        press: envelope.commandId,
      });
      const taken = new Map(undone.rooms.map(({ room, changes }) => [loroRoomName(room), changes]));
      const receipts = new Map<DocumentId, ReceiptWrite["receipts"]>();
      for (const [name, { forward, since }] of rooms) {
        const copy = copies.get(name) as RoomDocs;
        const here = parts.filter((part) => loroRoomName(part.room) === name);
        const { room, documentId, origin } = here[0] as RestorePart;
        const changes = taken.get(name) ?? [];
        const written = [...forward, ...changes];
        if (room.kind === "fork") {
          await commitCopy(room, { live: [], fork: written });
          await markFork(tx(), room, copy);
        } else if (written.length)
          await deps.rooms.commit(tx(), room, encodeChanges(written), ORIGIN);
        if (!changes.length) continue;
        const went = here.filter((part) => !undone.compacted.has(part));
        receipts.set(documentId, [
          ...(receipts.get(documentId) ?? []),
          {
            origin,
            targets: went.map(({ editId, ordinal }) => ({ editId, ordinal })),
            write: { edit: editSince(copy, since, new Set(changes.map((change) => change.key))) },
          },
        ]);
      }
      for (const [documentId, parts] of receipts)
        await recordDocumentEdit(tx(), {
          documentId,
          actor: "human",
          actorUserId: envelope.accountId as UserId,
          turnId: turn,
          kind: "undo",
          actionId: envelope.commandId,
          commandId: envelope.commandId,
          receipts: parts,
        });
      return [...receipts.keys()].sort();
    } finally {
      for (const copy of copies.values()) copy.free();
    }
  }

  async function storedPress(
    envelope: CommandEnvelope,
    id: string,
  ): Promise<{ result: PressResult; pressedAt: Date } | null> {
    const [row] = await tx()
      .select({ outcome: commands.outcome, pressedAt: commands.createdAt })
      .from(commands)
      .where(
        and(
          eq(commands.id, id as CommandId),
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
    const { saw: _saw, liveVersions: _shown, ...action } = request;
    const lists = listsOf(envelope);
    const parts = await partsOf(request.scope);
    const draftIds = parts.map((part) => part.draft);
    await saveLoadedForks(draftIds);
    const answer = (documents: Set<string>, tree: Set<string>, trashed: string[]): PressResult => ({
      status: "pressed",
      commandId: envelope.commandId as CommandId,
      ...action,
      documents: [...documents].sort() as DocumentId[],
      items: [...tree].sort().map((node) => ({ node, tree: true as const })),
      ...(trashed.length > 0 ? { trashed } : {}),
    });

    const run = (owners: TreeOwners) =>
      runDocumentCommand(db, envelope, () =>
        deps.workProjection.mutate(
          { drafts: draftIds, works: owners.works, lineages: owners.lineages },
          async (locked): Promise<PressResult> => {
            const living: DraftPart[] = [];
            for (const part of parts) if (await deps.drafts.lock(part.draft)) living.push(part);
            const judge = await owners.judge(locked);
            await deps.treeLists.lock(lists);
            const plan = [];
            // A restore reads the ledger here, under the drafts' and their Works' keys, which an
            // Undo of the same writes also holds: a second tab's restore finds them taken.
            for (const part of living) {
              const restore = part.turn
                ? await restorePlan(tx(), deps.treeLists, part.turn, part.draft)
                : null;
              plan.push({
                part,
                restore,
                nodes: restore ? restore.nodes : await treeNodes(lists, part),
                texts: restore
                  ? [...new Set(restore.parts.map((one) => one.documentId))]
                  : await textDocuments(part),
              });
            }
            await lockDocuments(plan.flatMap(({ nodes, texts }) => [...nodes, ...texts]));
            const documents = new Set<string>();
            const tree = new Set<string>();
            const trashed: string[] = [];
            for (const { part, restore, nodes, texts } of plan) {
              const selection: ChangeSelection = part.change ? [part.change] : "all";
              if (restore)
                for (const documentId of await takeBack(envelope, restore.parts, null))
                  documents.add(documentId);
              else
                for (const documentId of texts)
                  if (await pressText(envelope, request, part.draft, documentId, selection))
                    documents.add(documentId);
              if (nodes.length === 0) continue;
              if (request.verdict === "apply") {
                const listOf = await treeHalf.lockItems(nodes);
                const landed = await treeHalf.apply({
                  draftId: part.draft,
                  userId: envelope.accountId as UserId,
                  commandId: envelope.commandId as CommandId,
                  treeCommand: treeCommand(envelope.commandId, part.draft),
                  saw: request.saw,
                  items: nodes.map((node) => ({
                    node,
                    list: listOf.get(node) ?? null,
                    tree: true,
                  })),
                  judge,
                });
                for (const node of landed) tree.add(node);
              } else {
                const discarded = await discardTreeRecords(db, deps, {
                  draftId: part.draft,
                  userId: envelope.accountId as UserId,
                  commandId: treeCommand(envelope.commandId, part.draft),
                  trash: true,
                  ...(restore
                    ? { records: restore.records }
                    : part.tree === "all"
                      ? {}
                      : { documents: nodes as DocumentId[] }),
                });
                for (const node of discarded.had) tree.add(node);
                trashed.push(...discarded.trashed);
                if (part.tree === "all") await deps.treeLists.resync(lists);
              }
            }
            judge.assertLocked();
            return answer(documents, tree, trashed);
          },
        ),
      );

    if (request.verdict !== "apply") return run(NO_OWNERS);
    // The sources the drafts' pending records change, and where Live has the nodes they name:
    // their owners are locked with the drafts' and judged under the locks. A guess read before
    // the locks, so it can miss; a miss restarts.
    const sources = () =>
      deps.treeLists.read({
        lists,
        view: (ends) => {
          const out = new Set<string>();
          for (const { writer } of ends) {
            const live = writer.view(LIVE);
            for (const draft of draftIds) {
              const { changes } = writer.view({ draft });
              for (const record of pendingRecords(writer.doc, draft)) {
                for (const source of changes.get(record.id)?.sources ?? []) out.add(source);
                const node = live.nodes.get(record.node);
                if (node) out.add(node.source);
              }
            }
          }
          return out;
        },
      });
    return withTreeOwners(db, sources, run);
  }

  function trashedBy(doc: LoroDoc, discarded: string, trashed: readonly string[]): string[] {
    const made = new Set(
      discardedBy(doc, discarded).records.flatMap((record) =>
        record.type === "create" ? [record.node] : [],
      ),
    );
    const records = new Map(listRecords(doc).map((record) => [record.id, record]));
    return trashed.filter((id) => {
      const record = records.get(id);
      return record?.type === "delete" && made.has(record.node);
    });
  }

  async function undo(command: PressUndoCommand): Promise<PressUndoResult> {
    const { envelope, pressCommandId } = command;
    const pressId = pressCommandId as CommandId;
    const stored = await storedPress(envelope, pressId);
    const pressed = stored?.result;
    const answer = (documents: Set<string>, tree: Set<string>): PressUndoResult => ({
      status: "unpressed",
      commandId: envelope.commandId as CommandId,
      pressCommandId: pressId,
      documents: [...documents].sort() as DocumentId[],
      tree: [...tree].sort(),
    });
    if (!stored || !pressed)
      return runDocumentCommand(db, envelope, async () => answer(new Set(), new Set()));
    const lists = listsOf(envelope);
    const trees = await tx()
      .select()
      .from(applyCommandTrees)
      .where(eq(applyCommandTrees.commandId, pressId));
    const texts = await tx().select().from(pressChanges).where(eq(pressChanges.commandId, pressId));
    const draftIds = [
      ...new Set([
        ...trees.map((one) => one.draftId as DraftId),
        ...texts.map((one) => one.draftId as DraftId),
        ...(await partsOf(pressed.scope)).map((part) => part.draft),
      ]),
    ]
      .sort()
      .reverse();

    const run = (owners: TreeOwners) =>
      runDocumentCommand(db, envelope, () =>
        deps.workProjection.mutate(
          { drafts: draftIds, works: owners.works, lineages: owners.lineages },
          async (locked): Promise<PressUndoResult> => {
            const judge = await owners.judge(locked);
            const by = `user:${envelope.accountId}`;
            const author = { press: envelope.commandId };
            const living = new Set<DraftId>();
            for (const draft of [...draftIds].sort())
              if (await deps.drafts.lock(draft)) living.add(draft);
            await deps.treeLists.lock(lists);
            // A restore's text is in the ledger, read under the draft's key: a second Undo of it
            // finds its parts brought back already.
            const { scope } = pressed;
            const restored =
              scope.kind === "turn" && living.has(scope.draft)
                ? await restoredParts(tx(), pressId)
                : [];
            await lockDocuments([
              ...pressed.items.filter((item) => item.tree).map((item) => item.node),
              ...texts.map((row) => row.documentId),
              ...restored.map((part) => part.documentId),
            ]);
            const documents = new Set<string>();
            const tree = new Set<string>();
            if (scope.kind === "turn")
              for (const documentId of await takeBack(envelope, restored, scope.turn))
                documents.add(documentId);
            for (const draft of draftIds) {
              if (living.has(draft))
                for (const row of texts.filter((one) => one.draftId === draft)) {
                  const documentId = row.documentId as DocumentId;
                  const room = { kind: "fork" as const, draftId: draft, documentId };
                  const copy = await deps.rooms.read(room);
                  try {
                    const changes = row.changes as PressedChange[];
                    if (await commitCopy(room, undoPress(copy, changes, { by: author })))
                      documents.add(documentId);
                    await markFork(tx(), room, copy);
                  } finally {
                    copy.free();
                  }
                }
              const treeTouched =
                pressed.verdict !== "apply"
                  ? pressed.items.some((item) => item.tree) && living.has(draft)
                  : trees.some((one) => one.draftId === draft);
              if (!treeTouched) continue;
              await deps.treeLists.submit({
                lists,
                make: (ends) => {
                  const pressedHere = treeCommand(pressId, draft);
                  const undoHere = treeCommand(envelope.commandId, draft);
                  for (const [at, { writer }] of ends.entries()) {
                    if (pressed.verdict !== "apply") {
                      const restored = restoreDiscard(
                        writer,
                        pressedHere,
                        by,
                        draft,
                        undoHere,
                        trashedBy(writer.doc, pressedHere, pressed.trashed ?? []),
                      );
                      if (restored !== "already")
                        for (const record of [...restored.copies, ...restored.back])
                          tree.add(record.node);
                      continue;
                    }
                    const scope = lists[at]?.kind;
                    if (!trees.some((one) => one.draftId === draft && one.scope === scope))
                      continue;
                    const result = undoApply(writer, pressedHere, by, undoHere, {
                      closed: judge.closed,
                    });
                    for (const record of result.undone) tree.add(record.node);
                  }
                },
              });
            }
            judge.assertLocked();
            deps.usage?.pressUndone({
              projectId: envelope.projectId,
              verdict: pressed.verdict,
              pressedAt: stored.pressedAt,
              documentIds: [...documents] as DocumentId[],
            });
            return answer(documents, tree);
          },
          { requireActive: false },
        ),
      );

    if (pressed.verdict !== "apply") return run(NO_OWNERS);
    const sources = () =>
      deps.treeLists.read({
        lists,
        view: (ends) => {
          const out = new Set<string>();
          for (const { writer } of ends) {
            const live = writer.view(LIVE);
            for (const draft of draftIds)
              for (const record of madeBy(writer.doc, treeCommand(pressId, draft))) {
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
