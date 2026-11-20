/**
 * The model's view of a live document that holds suggestions. agent-edit reads and plans on a
 * copy of the view (Live, or Live with one Work's suggestions applied) and saves a Yjs update to
 * that copy; this coordinator turns the update into an edit of the live document, written as the
 * Work's suggestions, and saves that through the live coordinator on today's write path.
 */

import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import type { UpdateMeta } from "@meridian/agent-edit/integration";
import {
  bindBlockOrigins,
  blockItemIdKey,
  type DocumentCoordinator,
  getBlockItemId,
  getTopLevelXmlBlocks,
  type RoomRead,
  type SaveCut,
} from "@meridian/agent-edit/integration";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import {
  hasSuggestions,
  listSuggestions,
  type SuggestionFilter,
  settleInDoc,
  viewOf,
  writeThroughView,
} from "@meridian/suggestions";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";

const schema = buildDocumentSchema();

/**
 * What a view copy was read from: the live state, and the copy's own state. A save writes its
 * suggestions against `live` and Yjs merges them with whatever landed since. agent-edit saves a
 * copy once.
 */
class ViewBase {
  constructor(
    readonly live: Uint8Array,
    readonly view: Uint8Array,
  ) {}
}

/**
 * `work` null is the Live view: reads skip every suggestion and a write lands in the text. A
 * Work's view writes as that Work's suggestions.
 */
export function createSuggestionCoordinator(
  live: DocumentCoordinator,
  work: string | null,
): DocumentCoordinator {
  const report = live.concurrentUpdatesForReport?.bind(live);
  return {
    async readRoom(docId, access) {
      const read = await live.readRoom(docId, access);
      // A document with no suggestions is its own Live view: the model reads the room itself.
      if (work === null && !hasSuggestions(rootOf(read.doc))) return read;
      try {
        const view = viewDoc(read.doc, work);
        return {
          doc: view,
          room: null,
          ...(read.position === undefined ? {} : { position: read.position }),
          base: new ViewBase(Y.encodeStateAsUpdate(read.doc), Y.encodeStateAsUpdate(view)),
        } satisfies RoomRead;
      } finally {
        read.doc.destroy();
      }
    },

    async prepareSave({ base, ...input }) {
      if (!(base instanceof ViewBase)) return live.prepareSave(input);
      const [entry] = input.entries;
      if (input.entries.length !== 1 || !entry) throw new Error("A view saves one entry");
      const baseDoc = docOf(base.live);
      const viewBefore = base.view;
      const viewAfter = docOf(viewBefore);
      Y.applyUpdate(viewAfter, entry.update);
      const mutation = entry.mutation;
      const written = writeThroughView(
        rootOf(baseDoc),
        work,
        rootOf(viewAfter),
        work
          ? {
              work,
              chat: mutation?.threadId ?? null,
              turn: mutation?.turnId ?? null,
              by: mutation?.actorKind === "human" ? `user:${mutation.userId}` : "agent",
            }
          : null,
      );
      const update = written ? writeInto(baseDoc, written) : null;
      baseDoc.destroy();
      if (!update) return { room: null, write: { kind: "no-effect" } };
      const saved = await live.prepareSave({
        ...input,
        entries: [
          {
            ...entry,
            update,
            ...(mutation ? { mutation: { ...mutation, editParts: [update] } } : {}),
          },
        ],
      });
      if (saved.write.kind === "no-effect") return saved;
      const write = saved.write;
      return {
        room: null,
        write: {
          kind: "write",
          // The cut agent-edit reads back is in its own copy's ids: the view of what was saved.
          async persist(): Promise<SaveCut> {
            const cut = await write.persist();
            const savedLive = docOf(cut.afterState);
            writeBlocks(fragment(viewAfter), schema, children(viewOf(rootOf(savedLive), work).doc));
            savedLive.destroy();
            return {
              beforeState: viewBefore,
              afterState: Y.encodeStateAsUpdate(viewAfter),
              ...(cut.position === undefined ? {} : { position: cut.position }),
            };
          },
          transfer: () => write.transfer(),
          dispose: () => write.dispose(),
        },
      };
    },

    ...(report ? { concurrentUpdatesForReport: report } : {}),
  };
}

/**
 * Accepts or rejects suggestions in a live document as a client would: one update, saved on the
 * write path, inside the caller's transaction; the append takes the document's lock. False when the
 * filter names none.
 */
export async function settleInLive(
  live: DocumentCoordinator,
  docId: string,
  filter: SuggestionFilter,
  how: "accept" | "reject",
  meta: UpdateMeta,
): Promise<boolean> {
  const read = await live.readRoom(docId);
  try {
    const settled = settleInDoc(rootOf(read.doc), filter, how);
    const update = settled ? writeInto(read.doc, settled) : null;
    if (!update) return false;
    const saved = await live.prepareSave({ docId, entries: [{ docId, update, meta }] });
    if (saved.write.kind === "no-effect") return false;
    await saved.write.persist();
    saved.write.transfer();
    return true;
  } finally {
    read.doc.destroy();
  }
}

/** Whether a live document still holds suggestions a turn made: what its card's Undo would take back. */
export async function holdsTurnSuggestions(
  live: DocumentCoordinator,
  docId: string,
  turn: string,
): Promise<boolean> {
  const read = await live.readRoom(docId);
  try {
    return listSuggestions(rootOf(read.doc)).some((change) => change.turn === turn);
  } finally {
    read.doc.destroy();
  }
}

/** What readers (search, counts, links) read: the document without its suggestions. */
export function liveView(doc: Y.Doc): Y.Doc {
  return hasSuggestions(rootOf(doc)) ? viewDoc(doc, null) : doc;
}

/** A copy of the view, each block bound to the live block it shows so its hash is the live one. */
function viewDoc(liveDoc: Y.Doc, work: string | null): Y.Doc {
  const view = createCollabYDoc({ gc: false });
  writeBlocks(fragment(view), schema, children(viewOf(rootOf(liveDoc), work).doc));
  const liveById = new Map(
    getTopLevelXmlBlocks(liveDoc).map((block) => [block.getAttribute("id"), getBlockItemId(block)]),
  );
  const origins = new Map<string, ReturnType<typeof getBlockItemId>>();
  for (const block of getTopLevelXmlBlocks(view)) {
    const origin = liveById.get(block.getAttribute("id"));
    if (origin) origins.set(blockItemIdKey(getBlockItemId(block)), origin);
  }
  bindBlockOrigins(view, origins);
  return view;
}

/** Writes `target` into the live copy and returns the update that did it, or null for none. */
function writeInto(liveDoc: Y.Doc, target: PMNode): Uint8Array | null {
  const updates: Uint8Array[] = [];
  const collect = (update: Uint8Array) => updates.push(update);
  liveDoc.on("update", collect);
  try {
    liveDoc.transact(() => writeBlocks(fragment(liveDoc), schema, children(target)));
  } finally {
    liveDoc.off("update", collect);
  }
  return updates.length ? Y.mergeUpdates(updates) : null;
}

function docOf(state: Uint8Array): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, state);
  return doc;
}

function fragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
}

function rootOf(doc: Y.Doc): PMNode {
  return schema.topNodeType.create(null, readBlocks(fragment(doc), schema));
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => {
    out.push(child);
  });
  return out;
}
