/**
 * The model's view of a live document that holds suggestions. agent-edit reads and plans on a
 * copy of the view (Live, or Live with one Work's suggestions applied) and saves a Yjs update to
 * that copy; this coordinator turns the update into an edit of the live document, written as the
 * Work's suggestions, and saves that through the live coordinator on today's write path.
 */

import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
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
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
import { hasSuggestions, viewOf, writeThroughView } from "@meridian/suggestions";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";

const schema = buildDocumentSchema();

/**
 * The client every view copy is written by. Built from the same live state, two copies get the
 * same Yjs ids, so a save can rebuild the copy its update was made on instead of keeping it.
 */
const VIEW_CLIENT = RESERVED_CLIENT_ID_MAX + 1;

/**
 * `work` null is the Live view: reads skip every suggestion and a write lands in the text. A
 * Work's view writes as that Work's suggestions.
 */
export function createSuggestionCoordinator(
  live: DocumentCoordinator,
  work: string | null,
): DocumentCoordinator {
  return {
    async readRoom(docId, access) {
      const read = await live.readRoom(docId, access);
      try {
        // Rebuilt on every read: its Yjs ids name nothing a frontier could hold.
        return {
          doc: viewDoc(read.doc, work),
          room: null,
          ...(read.position === undefined ? {} : { position: read.position }),
        } satisfies RoomRead;
      } finally {
        read.doc.destroy();
      }
    },

    // The write's read and save run under the document's lock, so the live state here is the
    // one its view was read from.
    async prepareSave(input) {
      const [entry] = input.entries;
      if (input.entries.length !== 1 || !entry) throw new Error("A view saves one entry");
      const read = await live.readRoom(input.docId, input.access);
      const liveDoc = read.doc;
      const viewBefore = viewDoc(liveDoc, work);
      const viewAfter = docOf(Y.encodeStateAsUpdate(viewBefore));
      Y.applyUpdate(viewAfter, entry.update);
      const mutation = entry.mutation;
      const written = writeThroughView(
        rootOf(liveDoc),
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
      const update = written ? writeInto(liveDoc, written) : null;
      liveDoc.destroy();
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
              beforeState: Y.encodeStateAsUpdate(viewBefore),
              afterState: Y.encodeStateAsUpdate(viewAfter),
              ...(cut.position === undefined ? {} : { position: cut.position }),
            };
          },
          transfer: () => write.transfer(),
          dispose: () => write.dispose(),
        },
      };
    },
  };
}

/** What readers (search, counts, links) read: the document without its suggestions. */
export function liveView(doc: Y.Doc): Y.Doc {
  return hasSuggestions(rootOf(doc)) ? viewDoc(doc, null) : doc;
}

/** A fresh copy of the view, each block bound to the live block it shows so its hash is the live one. */
function viewDoc(liveDoc: Y.Doc, work: string | null): Y.Doc {
  const view = new Y.Doc({ gc: false });
  view.clientID = VIEW_CLIENT;
  writeBlocks(fragment(view), schema, children(viewOf(rootOf(liveDoc), work).doc));
  const liveBlocks = getTopLevelXmlBlocks(liveDoc);
  bindBlockOrigins(
    view,
    new Map(
      getTopLevelXmlBlocks(view).map((block, index) => [
        blockItemIdKey(getBlockItemId(block)),
        getBlockItemId(liveBlocks[index]),
      ]),
    ),
  );
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
