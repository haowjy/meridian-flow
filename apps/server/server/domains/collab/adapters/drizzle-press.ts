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
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
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
  membersOf,
  type PressedChange,
  type RoomDocs,
  type RoomVersion,
  type StoredEdit,
  undoEdits,
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
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { NO_OWNERS, type TreeOwners, withTreeOwners } from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Drafts } from "../domain/drafts.js";
import type { TreeCut } from "../domain/press.js";
import { markFork } from "../rooms/postgres-document-rooms.js";
import { createApplyTreeOperations } from "./drizzle-apply-tree.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { type RestorePlan, readRooms, restorePlan } from "./drizzle-restore-before.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";
import type { UsageEvents } from "./usage-events.js";

export type PressCommand = {
  envelope: CommandEnvelope;
  /** `liveVersions` decoded: the Live version each document's tab showed. */
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

/** One draft's part of a press: which documents' text and which tree records it takes. */
type DraftPart = {
  draft: DraftId;
  /** The documents whose text it presses; "all" is every fork the draft has pending. */
  documents: DocumentId[] | "all";
  /** The change a `change` press names; null presses every change in those documents. */
  change: string | null;
  /** The tree records it settles: one document's, every pending one, or none (a change, a turn). */
  tree: DocumentId[] | "all";
  /** An `Undo turn`'s turn, whose writes into the draft's forks it takes back. */
  turn?: TurnId;
};

const ORIGIN = "server:press";

/**
 * A draft's part of a command in its tree lists, which take each command name once; a record
 * names it as a tree id (64 of `[0-9a-zA-Z_-]`).
 */
const treeCommand = (commandId: string, draft: DraftId) => `${commandId}_${draft}`;

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

  /** The lists a Work's tree can span: its project's and the account's. */
  const listsOf = (envelope: CommandEnvelope): TreeList[] => [
    ...(envelope.projectId ? [{ kind: "project" as const, projectId: envelope.projectId }] : []),
    { kind: "account", userId: envelope.accountId },
  ];

  /** The drafts a scope presses, in draft id order, each with what it takes. */
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
              .where(and(eq(drafts.workId, scope.work as WorkId), isNull(drafts.deletedAt)))
              .orderBy(asc(drafts.id))
          ).map((row) => row.id as DraftId);
    return ids.map((draft) => ({ draft, documents: "all", change: null, tree: "all" }));
  }

  /** The documents whose forks the part presses: those named, or every fork the draft has pending. */
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

  /** The nodes whose tree records the part settles, read under the lists' keys. */
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

  async function lockDocuments(documents: Iterable<string>): Promise<void> {
    for (const id of [...new Set(documents)].sort())
      await lockDocumentMutation(tx(), id as DocumentId);
  }

  /** Commits a press copy's changes: Live's room first, then the fork's. */
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

  /**
   * A draft's fork of one document, pressed on a command copy (its own peer, so the press's
   * writes are its own) and committed. Its changes' edits go in `press_changes`.
   */
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
      // An Apply writes Live and may leave the fork no write: its pending flag is read here.
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

  /**
   * A Draft chat turn's `Undo turn` in one draft (design §2), from its plan
   * (`drizzle-restore-before.ts`): the turn's writes into the draft's text go back by the one Undo
   * rule, newest first, each in the room it landed in, a fork carried forward to today's Live
   * first (`undoInRooms`); Live's manuscript is untouched. A write whose history the room cut
   * stays as it is. Each room's restore is one
   * edit, stored in `press_changes` on the side of the room it was written in (`fork`, or `live`
   * for a document only the draft holds), so the press's Undo takes it back by the same rule.
   * Returns the documents whose text it changed.
   */
  async function restoreDraft(
    envelope: CommandEnvelope,
    draft: DraftId,
    plan: RestorePlan,
  ): Promise<DocumentId[]> {
    const copies = await readRooms(deps.rooms, plan);
    try {
      const rooms = new Map<
        string,
        { room: DocumentRoom; forward: DocChange[]; since: RoomVersion }
      >();
      for (const { room } of plan.parts) {
        const name = loroRoomName(room);
        if (rooms.has(name)) continue;
        const copy = copies.get(name) as RoomDocs;
        const forward = copy.live ? copy.forward().restore : [];
        rooms.set(name, { room, forward, since: copy.shownVersion() });
      }
      const undone = undoInRooms(plan.parts, (room) => copies.get(loroRoomName(room)) as RoomDocs, {
        press: envelope.commandId,
      });
      const taken = new Map(undone.rooms.map(({ room, changes }) => [loroRoomName(room), changes]));
      const documents: DocumentId[] = [];
      for (const [name, { room, forward, since }] of rooms) {
        const copy = copies.get(name) as RoomDocs;
        const changes = taken.get(name) ?? [];
        const written = [...forward, ...changes];
        const documentId = room.documentId as DocumentId;
        if (room.kind === "fork") {
          await commitCopy(room, { live: [], fork: written });
          await markFork(tx(), room, copy);
        } else if (written.length)
          await deps.rooms.commit(tx(), room, encodeChanges(written), ORIGIN);
        if (!changes.length) continue;
        documents.push(documentId);
        const edit = editSince(copy, since, new Set(changes.map((change) => change.key)));
        const members = [
          ...new Set([
            ...edit.texts.map(([key]) => key),
            ...edit.values.flatMap(([name, keys]) => keys.flatMap(([key]) => membersOf(name, key))),
          ]),
        ];
        const [first, ...rest] = members;
        if (first)
          await tx()
            .insert(pressChanges)
            .values({
              commandId: envelope.commandId as CommandId,
              draftId: draft,
              documentId,
              changes: [
                {
                  members: [first, ...rest],
                  live: room.kind === "live" ? edit : null,
                  fork: room.kind === "fork" ? edit : null,
                },
              ] satisfies PressedChange[],
            });
      }
      return documents;
    } finally {
      for (const copy of copies.values()) copy.free();
    }
  }

  /** A press this account made in this project, as it answered: null for an unknown or purged id. */
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
            // A purged draft has nothing left to press.
            const living: DraftPart[] = [];
            for (const part of parts) if (await deps.drafts.lock(part.draft)) living.push(part);
            const judge = await owners.judge(locked);
            await deps.treeLists.lock(lists);
            const plan = [];
            for (const part of living) {
              const restore = part.turn ? await restorePlan(tx(), part.turn, part.draft) : null;
              plan.push({
                part,
                restore,
                nodes: restore ? restore.created : await treeNodes(lists, part),
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
              if (restore)
                for (const documentId of await restoreDraft(envelope, part.draft, restore))
                  documents.add(documentId);
              // The text half first: an Apply's created documents land with their text.
              const selection: ChangeSelection = part.change ? [part.change] : "all";
              if (!restore)
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
                  ...(part.tree === "all" ? {} : { documents: nodes as DocumentId[] }),
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

    // A Discard and an Undo turn change no Live tree record: no owner to judge.
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

  /** Of a Discard's Trash deletes, those of one draft's part: each takes a node its creates made. */
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
    // Another account's press, an unknown id, or one the day-30 purge took: nothing to take back.
    if (!stored || !pressed)
      return runDocumentCommand(db, envelope, async () => answer(new Set(), new Set()));
    const lists = listsOf(envelope);
    const trees = await tx()
      .select()
      .from(applyCommandTrees)
      .where(eq(applyCommandTrees.commandId, pressId));
    const texts = await tx().select().from(pressChanges).where(eq(pressChanges.commandId, pressId));
    // Newest first: the press went in draft id order.
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
            await lockDocuments([
              ...pressed.items.filter((item) => item.tree).map((item) => item.node),
              ...texts.map((row) => row.documentId),
            ]);
            const documents = new Set<string>();
            const tree = new Set<string>();
            for (const draft of draftIds) {
              // A purged draft's forks went with it: its text has nothing to come back to.
              if (living.has(draft))
                for (const row of texts.filter((one) => one.draftId === draft)) {
                  const documentId = row.documentId as DocumentId;
                  const changes = row.changes as PressedChange[];
                  // An Undo turn of a document only the draft holds wrote its Live room. An
                  // Apply's change has no fork side either when the fork kept nothing to delete.
                  const liveRoom =
                    pressed.verdict === "restore" &&
                    changes.every((change) => change.fork === null);
                  const room: DocumentRoom = liveRoom
                    ? { kind: "live", documentId }
                    : { kind: "fork", draftId: draft, documentId };
                  const copy = await deps.rooms.read(room);
                  try {
                    if (room.kind === "live") {
                      const undone = undoEdits(
                        copy,
                        changes.map((change) => change.live as StoredEdit),
                        author,
                      );
                      if (undone.changes.length) {
                        await deps.rooms.commit(tx(), room, encodeChanges(undone.changes), ORIGIN);
                        documents.add(documentId);
                      }
                      continue;
                    }
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
    // The sources the press's copies changed and where Live has their nodes and its documents.
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
