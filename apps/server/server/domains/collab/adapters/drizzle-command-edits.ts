/**
 * A writer's press that writes text (Apply, Discard, and the Undo of either) records what it
 * changed as `document_edits` parts, the record AI writes keep: one part per text it wrote (Live, a
 * draft's text, a draft's review base). One operation takes any of them back: `undoCommandText`.
 * Un-Apply, Restore of a Discard and Redo (the Undo of an Un-Apply) are that call.
 */
import { captureDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import { REVIEW_BASE_FRAGMENT, readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { CommandId, DocumentId, EditOrigin, UserId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  commands,
  documentDrafts,
  documentEditParts,
  documentEdits,
} from "@meridian/database/schema";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { draftSchema, takeBack } from "../domain/draft-changes.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import { partKey } from "../domain/inverse-actions.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { storedDocument } from "../domain/stored-document.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";
import { writeTextAnswer } from "./drizzle-text-answer.js";

const schema = draftSchema;
type Tx = ReturnType<typeof currentDrizzleDb>;

type CommandPart = {
  id: number;
  editId: string;
  ordinal: number;
  documentId: DocumentId;
  origin: EditOrigin;
  delta: StoredDelta | null;
  targets: { editId: string; ordinal: number }[];
  carried: [number, number][] | null;
};

const partColumns = {
  id: documentEditParts.id,
  editId: documentEditParts.editId,
  ordinal: documentEditParts.ordinal,
  documentId: documentEdits.documentId,
  origin: documentEditParts.origin,
  delta: documentEditParts.delta,
  targets: documentEditParts.targets,
  carried: documentEditParts.carried,
};

/**
 * A writer's command's own edits. A draft append under the command also records a system `write`
 * receipt for its rows with the command's id; that is the append's, not the command's record.
 */
const commandKinds = inArray(documentEdits.kind, ["apply", "discard", "undo"]);

/** The parts the commands' own edits wrote, newest first. */
export async function partsOf(
  tx: Tx,
  commandIds: readonly string[],
): Promise<(CommandPart & { commandId: string })[]> {
  if (commandIds.length === 0) return [];
  return tx
    .select({ ...partColumns, commandId: sql<string>`${documentEdits.commandId}` })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(and(inArray(documentEdits.commandId, [...commandIds] as CommandId[]), commandKinds))
    .orderBy(desc(documentEditParts.id));
}

/**
 * Which of `parts` are in force: no command Undo in force targets them. An Undo is itself a part,
 * so a Redo (the Undo of an Un-Apply) puts the Apply's parts back in force. The card's and the
 * model's Undo carry an `actionId` and never target a command's parts.
 */
async function inForceAmong(tx: Tx, parts: readonly CommandPart[]): Promise<Set<string>> {
  if (parts.length === 0) return new Set();
  const undos = await tx
    .select({
      editId: documentEditParts.editId,
      ordinal: documentEditParts.ordinal,
      targets: documentEditParts.targets,
    })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(
      and(
        eq(documentEdits.kind, "undo"),
        isNull(documentEdits.actionId),
        inArray(documentEdits.documentId, [...new Set(parts.map((part) => part.documentId))]),
      ),
    );
  const takenBy = new Map<string, string[]>();
  for (const undo of undos)
    for (const target of undo.targets)
      takenBy.set(partKey(target), [...(takenBy.get(partKey(target)) ?? []), partKey(undo)]);
  const memo = new Map<string, boolean>();
  const inForce = (key: string): boolean => {
    let known = memo.get(key);
    if (known === undefined) {
      known = !(takenBy.get(key) ?? []).some(inForce);
      memo.set(key, known);
    }
    return known;
  };
  return new Set(parts.map(partKey).filter(inForce));
}

/**
 * Each draft's Applies in force: the AI changes each carried, from its review-base part. What the
 * card reads "Applied" from, and what settles an Apply's text half as already applied.
 */
export async function appliesInForce(
  tx: Tx,
  draftIds: readonly string[],
): Promise<{ draftId: string; carried: [number, number][] }[]> {
  if (draftIds.length === 0) return [];
  const rows = await tx
    .select(partColumns)
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(
      and(
        eq(documentEdits.kind, "apply"),
        sql`${documentEditParts.origin}->>'kind' = 'base'`,
        inArray(sql`${documentEditParts.origin}->>'draftId'`, [...draftIds]),
      ),
    );
  const inForce = await inForceAmong(tx, rows);
  return rows.flatMap((row) =>
    inForce.has(partKey(row)) && row.origin.kind === "base"
      ? [{ draftId: row.origin.draftId, carried: row.carried ?? [] }]
      : [],
  );
}

/** The documents a writer's command wrote text in, when it is this account's own. */
export async function documentsOfCommand(
  tx: Tx,
  commandId: string,
  accountId: UserId,
): Promise<{ documentId: DocumentId; draftIds: string[] }[]> {
  const rows = await tx
    .select({ documentId: documentEdits.documentId, origin: documentEditParts.origin })
    .from(documentEdits)
    .innerJoin(commands, eq(commands.id, documentEdits.commandId))
    .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    .where(
      and(
        eq(documentEdits.commandId, commandId as CommandId),
        eq(commands.accountId, accountId),
        commandKinds,
      ),
    );
  const out = new Map<DocumentId, Set<string>>();
  for (const row of rows) {
    const drafts = out.get(row.documentId) ?? new Set<string>();
    if (row.origin.kind !== "live") drafts.add(row.origin.draftId);
    out.set(row.documentId, drafts);
  }
  return [...out].map(([documentId, drafts]) => ({ documentId, draftIds: [...drafts] }));
}

/** A document an Undo took text back in, and the server clock of the draft it wrote, if any. */
export type UndoneText = { documentId: DocumentId; at?: number };

export type UndoTextDeps = {
  live: UpdateJournal;
  liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
  coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
  treeLists: Pick<TreeListStore, "lock" | "resync">;
  onCommitted(documentId: DocumentId): Promise<void>;
};

/**
 * Takes back what `undoes` wrote, in the documents `only` names (all when absent): each change of
 * each part in force that still stands in the text the part wrote (Live, a draft's text, a draft's
 * review base), newest first. Records one `undo` edit per document it changed, with one part per
 * text it changed, each naming every part of the document it was asked to take: a part partly
 * taken, or not taken at all beside one that was, is taken. A document where nothing stood keeps
 * its parts in force. The caller holds the command's claim and the documents' keys; writes are
 * delivered after commit.
 */
export async function undoCommandText(
  db: Database,
  deps: UndoTextDeps,
  input: {
    commandId: string;
    undoes: string;
    accountId: UserId;
    only?: ReadonlySet<string>;
  },
): Promise<UndoneText[]> {
  const tx = currentDrizzleDb(db);
  const all = (await partsOf(tx, [input.undoes])).filter(
    (part) => !input.only || input.only.has(part.documentId),
  );
  const inForce = await inForceAmong(tx, all);
  const open = all.filter((part) => inForce.has(partKey(part)));
  const targets = (parts: readonly CommandPart[]) =>
    parts.map(({ editId, ordinal }) => ({ editId, ordinal }));
  const out: UndoneText[] = [];
  for (const documentId of [...new Set(open.map((part) => part.documentId))].sort()) {
    const own = open.filter((part) => part.documentId === documentId);
    // The command's effect on a document is one: a press that changed any of its texts takes all
    // of its parts, so a base the writer has since rewritten no longer reads the change Applied.
    const taken = targets(own);
    const result: UndoneText = { documentId };
    const receipts: Parameters<typeof recordDocumentEdit>[1]["receipts"] = [];
    const liveParts = own.filter((part) => part.origin.kind === "live");
    if (liveParts.length) {
      const snapshot = await deps.live.read(documentId);
      const doc = storedDocument(snapshot);
      try {
        const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        const before = readBlocks(fragment, schema);
        const after = takeBack(before, liveParts).text;
        const updates =
          after === before
            ? []
            : captureMutationUpdates(doc, () =>
                doc.transact(() => writeBlocks(fragment, schema, after), "undo"),
              );
        if (updates.length) {
          const update = Y.mergeUpdates(updates);
          const seq = await deps.live.append(
            documentId,
            update,
            { seq: 0, origin: `human:${input.accountId}` },
            snapshot.authority,
          );
          receipts.push({
            update,
            effect: { inserted: [], deleted: [] },
            origin: { kind: "live", seq },
            delta: captureDelta(before, after),
            targets: taken,
          });
          deferUntilDrizzleCommit(async () => {
            await deps.liveCoordinator.deliver(documentId);
            await deps.onCommitted(documentId);
          });
        }
      } finally {
        doc.destroy();
      }
    }
    const draftIds = new Set(
      own.flatMap((part) => (part.origin.kind === "live" ? [] : [part.origin.draftId])),
    );
    for (const draftId of [...draftIds].sort()) {
      const textParts = own.filter(
        (part) => part.origin.kind === "pending" && part.origin.draftId === draftId,
      );
      const baseParts = own.filter(
        (part) => part.origin.kind === "base" && part.origin.draftId === draftId,
      );
      const [row] = await tx
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, draftId));
      // A purged draft has nothing to write back into, and no branch for its parts to name.
      if (!row) continue;
      let text: { rows: Uint8Array[]; delta: StoredDelta | null } = { rows: [], delta: null };
      let base: typeof text = { rows: [], delta: null };
      let at = 0;
      const write = deps.coordinator.prepareAppend(await deps.coordinator.loadBase(draftId), [], {
        work: "any",
        authorServerRows(prefix) {
          const take = (name: string, parts: readonly CommandPart[]) => {
            const fragment = prefix.getXmlFragment(name);
            const before = readBlocks(fragment, schema);
            const after = takeBack(before, parts).text;
            if (after === before) return { rows: [], delta: null };
            const rows = captureMutationUpdates(prefix, () =>
              prefix.transact(() => writeBlocks(fragment, schema, after), "undo"),
            );
            return { rows, delta: captureDelta(before, after) };
          };
          text = take(PROSEMIRROR_FRAGMENT_NAME, textParts);
          base = take(REVIEW_BASE_FRAGMENT, baseParts);
          const rows = [...text.rows, ...base.rows];
          if (rows.length) at = Y.getState(prefix.store, prefix.clientID);
          return rows;
        },
      });
      try {
        await write.persist();
        write.transfer();
      } finally {
        write.dispose();
      }
      if (text.rows.length)
        receipts.push({
          update: Y.mergeUpdates(text.rows),
          effect: { inserted: [], deleted: [] },
          origin: { kind: "pending", draftId },
          delta: text.delta,
          targets: taken,
        });
      if (base.rows.length)
        receipts.push({
          update: Y.mergeUpdates(base.rows),
          effect: { inserted: [], deleted: [] },
          origin: { kind: "base", draftId },
          delta: base.delta,
          targets: taken,
        });
      if (!at) continue;
      result.at = at;
      // The draft holds a change again; the projection judges its count.
      await writeTextAnswer(db, deps.treeLists, {
        draftId,
        hasEffect: true,
        hasEffectRevision: -1,
        listsHeld: true,
      });
    }
    if (receipts.length) {
      await recordDocumentEdit(tx, {
        documentId,
        actor: "human",
        actorUserId: input.accountId,
        kind: "undo",
        commandId: input.commandId,
        receipts,
      });
      out.push(result);
    }
  }
  return out;
}
