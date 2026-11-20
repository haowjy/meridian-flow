/**
 * A writer's press that writes text (Apply, Discard, and the Undo of either) records what it
 * changed as `document_edits` parts, the record AI writes keep. One operation takes any of them
 * back: `undoCommandText` takes each change of the command's parts out where it still stands, and
 * records an `undo` edit naming the parts it took. Un-Apply, Restore of a Discard and Redo (the
 * Undo of an Un-Apply) are that call.
 */
import {
  captureDelta,
  changeStateIn,
  editChanges,
  readDelta,
  type StoredDelta,
  takeOut,
} from "@meridian/agent-edit/content-merge";
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
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { draftSchema } from "../domain/draft-changes.js";
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

/** The parts the command's edits wrote, newest first. */
async function partsOf(tx: Tx, commandId: string): Promise<CommandPart[]> {
  return tx
    .select(partColumns)
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(eq(documentEdits.commandId, commandId as CommandId))
    .orderBy(desc(documentEditParts.id));
}

/** Which of `parts` an Undo has taken back. */
async function takenAmong(tx: Tx, parts: readonly CommandPart[]): Promise<Set<string>> {
  if (parts.length === 0) return new Set();
  const keys = new Set(parts.map(partKey));
  const undos = await tx
    .select({ targets: documentEditParts.targets })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(
      and(
        eq(documentEdits.kind, "undo"),
        inArray(documentEdits.documentId, [...new Set(parts.map((part) => part.documentId))]),
      ),
    );
  const taken = new Set<string>();
  for (const { targets } of undos)
    for (const target of targets) if (keys.has(partKey(target))) taken.add(partKey(target));
  return taken;
}

/** The parts the commands wrote that no Undo has taken back, with each part's command. */
export async function untakenPartsOf(
  tx: Tx,
  commandIds: readonly string[],
): Promise<(CommandPart & { commandId: string })[]> {
  if (commandIds.length === 0) return [];
  const rows = await tx
    .select({ ...partColumns, commandId: sql<string>`${documentEdits.commandId}` })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(inArray(documentEdits.commandId, [...commandIds] as CommandId[]));
  const taken = await takenAmong(tx, rows);
  return rows.filter((row) => !taken.has(partKey(row)));
}

/**
 * The parts of each draft's Applies still in force (carried set and no Undo took them), oldest
 * first, with the command that wrote them: what the card reads "Applied" from and what settles an
 * Apply's text half as already applied.
 */
export async function appliesInForce(
  tx: Tx,
  draftIds: readonly string[],
): Promise<
  { draftId: string; commandId: string; carried: [number, number][]; documentId: DocumentId }[]
> {
  if (draftIds.length === 0) return [];
  const rows = await tx
    .select({ ...partColumns, commandId: documentEdits.commandId })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(
      and(
        isNotNull(documentEditParts.carried),
        sql`${documentEditParts.origin}->>'kind' = 'live'`,
        inArray(sql`${documentEditParts.origin}->>'draftId'`, [...draftIds]),
      ),
    )
    .orderBy(documentEditParts.id);
  const taken = await takenAmong(tx, rows);
  return rows.flatMap((row) =>
    taken.has(partKey(row)) || !row.commandId || row.origin.kind !== "live" || !row.origin.draftId
      ? []
      : [
          {
            draftId: row.origin.draftId,
            commandId: row.commandId,
            carried: row.carried ?? [],
            documentId: row.documentId,
          },
        ],
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
      and(eq(documentEdits.commandId, commandId as CommandId), eq(commands.accountId, accountId)),
    );
  const out = new Map<DocumentId, Set<string>>();
  for (const row of rows) {
    const drafts = out.get(row.documentId) ?? new Set<string>();
    if (row.origin.draftId) drafts.add(row.origin.draftId);
    out.set(row.documentId, drafts);
  }
  return [...out].map(([documentId, drafts]) => ({ documentId, draftIds: [...drafts] }));
}

/** What an Undo took back in one document: whether Live changed, and each draft it wrote with its server clock after. */
export type UndoneText = {
  documentId: DocumentId;
  live: boolean;
  drafts: { draftId: string; at: number }[];
};

type Change = ReturnType<typeof editChanges>[number];

/** Each change of the parts that stands in `blocks`, taken out in turn, newest part first. */
function takeStanding(
  blocks: readonly PMNode[],
  parts: readonly CommandPart[],
  taken: (part: CommandPart, change: Change) => void,
): readonly PMNode[] {
  let text = blocks;
  for (const part of parts) {
    if (!part.delta) continue;
    for (const change of editChanges(schema, readDelta(schema, part.delta)).reverse())
      if (changeStateIn(schema, change, text) === "stands") {
        text = takeOut(schema, change, text);
        taken(part, change);
      }
  }
  return text;
}

export type UndoTextDeps = {
  live: UpdateJournal;
  liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
  coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
  treeLists: Pick<TreeListStore, "lock" | "resync">;
  onCommitted(documentId: DocumentId): Promise<void>;
};

/**
 * Takes back what `undoes` wrote, in the documents `only` names (all when absent): each change of
 * each part not already taken that still stands where the part wrote it, newest first. A Live
 * part that also wrote a draft's review base (an Apply's) is taken out of that base too, so the
 * change is pending in the draft again. Records one `undo` edit per document it changed. The
 * caller holds the command's claim and the documents' keys; writes are delivered after commit.
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
  const all = (await partsOf(tx, input.undoes)).filter(
    (part) => !input.only || input.only.has(part.documentId),
  );
  const taken = await takenAmong(tx, all);
  const open = all.filter((part) => !taken.has(partKey(part)));
  // What the parts an Undo takes had themselves taken back: a part that took back an Apply's
  // carries that Apply's AI changes into Live again.
  const grand = new Map<string, [number, number][] | null>();
  const targetKeys = open.flatMap((part) => part.targets);
  if (targetKeys.length) {
    const rows = await tx
      .select({
        editId: documentEditParts.editId,
        ordinal: documentEditParts.ordinal,
        carried: documentEditParts.carried,
      })
      .from(documentEditParts)
      .where(inArray(documentEditParts.editId, [...new Set(targetKeys.map((key) => key.editId))]));
    for (const row of rows) grand.set(partKey(row), row.carried);
  }
  const out: UndoneText[] = [];
  for (const documentId of [...new Set(open.map((part) => part.documentId))].sort()) {
    const own = open.filter((part) => part.documentId === documentId);
    const result: UndoneText = { documentId, live: false, drafts: [] };
    const receipts: Parameters<typeof recordDocumentEdit>[1]["receipts"] = [];
    // Live, and with it each draft base its parts also wrote.
    const liveParts = own.filter((part) => part.origin.kind === "live");
    const baseChanges = new Map<string, Change[]>();
    if (liveParts.length) {
      const snapshot = await deps.live.read(documentId);
      const doc = storedDocument(snapshot);
      try {
        const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        const before = readBlocks(fragment, schema);
        const tookParts: CommandPart[] = [];
        const after = takeStanding(before, liveParts, (part, change) => {
          if (!tookParts.includes(part)) tookParts.push(part);
          const draftId = part.origin.kind === "live" ? part.origin.draftId : undefined;
          if (draftId) baseChanges.set(draftId, [...(baseChanges.get(draftId) ?? []), change]);
        });
        // A part with no delta found Live already holding its text: there is nothing to take
        // out, and it is taken back with the rest.
        const empty = liveParts.filter((part) => !part.delta);
        if (tookParts.length || empty.length) {
          const updates = tookParts.length
            ? captureMutationUpdates(doc, () =>
                doc.transact(() => writeBlocks(fragment, schema, after), "undo"),
              )
            : [];
          const update = updates.length ? Y.mergeUpdates(updates) : new Uint8Array();
          const seq = updates.length
            ? await deps.live.append(
                documentId,
                update,
                { seq: 0, origin: `human:${input.accountId}` },
                snapshot.authority,
              )
            : 0;
          const drafts = new Set(
            [...tookParts, ...empty].flatMap((part) =>
              part.origin.kind === "live" && part.origin.draftId ? [part.origin.draftId] : [],
            ),
          );
          const carried = [...tookParts, ...empty].flatMap((part) =>
            part.targets.flatMap((target) => grand.get(partKey(target)) ?? []),
          );
          const reapplies = [...tookParts, ...empty].some((part) =>
            part.targets.some((target) => grand.get(partKey(target))),
          );
          receipts.push({
            update,
            effect: { inserted: [], deleted: [] },
            origin: {
              kind: "live",
              seq,
              ...(drafts.size === 1 ? { draftId: [...drafts][0] as string } : {}),
            },
            delta: captureDelta(before, after),
            targets: [...tookParts, ...empty].map(({ editId, ordinal }) => ({ editId, ordinal })),
            carried: reapplies ? carried : null,
          });
          result.live = updates.length > 0;
          if (updates.length)
            deferUntilDrizzleCommit(async () => {
              await deps.liveCoordinator.deliver(documentId);
              await deps.onCommitted(documentId);
            });
        }
      } finally {
        doc.destroy();
      }
    }
    // Each draft: its text for the parts that wrote it, its base for the Live changes taken.
    const textParts = own.filter((part) => part.origin.kind === "pending");
    const draftIds = new Set([
      ...baseChanges.keys(),
      ...textParts.map((part) => (part.origin.kind === "pending" ? part.origin.draftId : "")),
    ]);
    for (const draftId of [...draftIds].sort()) {
      const [row] = await tx
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, draftId));
      // A purged draft has nothing to write back into.
      if (!row) continue;
      const parts = textParts.filter(
        (part) => part.origin.kind === "pending" && part.origin.draftId === draftId,
      );
      const tookParts: CommandPart[] = [];
      let delta: StoredDelta | null = null;
      let written: Uint8Array[] = [];
      let at = 0;
      const write = deps.coordinator.prepareAppend(await deps.coordinator.loadBase(draftId), [], {
        work: "any",
        authorServerRows(prefix) {
          const textFragment = prefix.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
          const baseFragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
          const textBefore = readBlocks(textFragment, schema);
          const textAfter = takeStanding(textBefore, parts, (part) => {
            if (!tookParts.includes(part)) tookParts.push(part);
          });
          let base = readBlocks(baseFragment, schema);
          const baseBefore = base;
          for (const change of baseChanges.get(draftId) ?? []) base = takeOut(schema, change, base);
          delta = tookParts.length ? captureDelta(textBefore, textAfter) : null;
          const rows = captureMutationUpdates(prefix, () =>
            prefix.transact(() => {
              if (tookParts.length) writeBlocks(textFragment, schema, textAfter);
              if (base !== baseBefore) writeBlocks(baseFragment, schema, base);
            }, "undo"),
          );
          written = rows;
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
      if (!at) continue;
      result.drafts.push({ draftId, at });
      if (tookParts.length)
        receipts.push({
          update: Y.mergeUpdates(written),
          effect: { inserted: [], deleted: [] },
          origin: { kind: "pending", draftId },
          delta,
          targets: tookParts.map(({ editId, ordinal }) => ({ editId, ordinal })),
          carried: null,
        });
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
