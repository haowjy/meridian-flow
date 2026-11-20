/**
 * Suggestion mode (prototype): the card's Undo of a turn whose edits are still suggestions rejects
 * them, as a client of the document would: read the stored document, reject the turn's marks, write
 * the blocks back. Text the writer typed beside them is untouched. The documents where the turn
 * left no suggestion (it wrote Live there) are undone the existing way. The card offers Undo while
 * any of the turn's documents still holds its suggestions, whatever the writer edited since.
 */
import { writeBlocks } from "@meridian/agent-edit/diff";
import type { ReversalOutcome, TurnReceiptChip } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { pendingTurns, reject } from "@meridian/suggestions";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type * as Y from "yjs";
import type { DocumentWriteOrigin, HeldLiveDocument } from "../contracts.js";
import type { TurnInverseQuery } from "./turn-inverse-service.js";

type Query = TurnInverseQuery & { actor: { type: "user"; userId: string } | { type: "agent" } };

export function createSuggestionTurnUndo(deps: {
  schema: Schema;
  listTurnDocuments(
    threadId: ThreadId,
    turnId: TurnId,
  ): Promise<readonly { documentId: DocumentId }[]>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  changeLiveDocument(input: {
    documentId: DocumentId;
    origin: DocumentWriteOrigin;
    mutate(doc: Y.Doc): void;
  }): Promise<void>;
  reverseLiveTurn(query: Query): Promise<ReversalOutcome>;
  withLiveDocument<T>(
    documentId: string,
    operation: (held: HeldLiveDocument) => Promise<T>,
  ): Promise<T>;
  liveTurnChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
}) {
  const rootOf = (doc: Y.Doc) =>
    yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), deps.schema);
  // Every card of a long thread asks after each pause in typing: one read per document state.
  const pending = new WeakMap<Y.Doc, Set<string>>();
  const turnsIn = (doc: Y.Doc) => {
    let turns = pending.get(doc);
    if (!turns) {
      turns = pendingTurns(rootOf(doc));
      pending.set(doc, turns);
      doc.once("afterTransaction", () => pending.delete(doc));
    }
    return turns;
  };

  async function holdsSuggestions(threadId: ThreadId, turn: TurnId): Promise<boolean> {
    const targets = await deps.listTurnDocuments(threadId, turn);
    for (const documentId of new Set(targets.map((target) => target.documentId)))
      if (await deps.withLiveDocument(documentId, async ({ doc }) => turnsIn(doc).has(turn)))
        return true;
    return false;
  }

  async function chip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null> {
    const live = await deps.liveTurnChip(threadId, turnId);
    if (live?.control === "undo" || !(await holdsSuggestions(threadId, turnId))) return live;
    return { drafts: live?.drafts, control: "undo" };
  }

  const reverseTurn = async (query: Query): Promise<ReversalOutcome> => {
    const turn = query.turnId;
    if (!turn) return { status: "nothing_to_undo", documents: [] };
    const targets = await deps.listTurnDocuments(query.threadId, turn);
    const documentIds = [...new Set(targets.map((target) => target.documentId))];
    const documents = [];
    for (const documentId of documentIds) {
      let rejected = false;
      await deps.changeLiveDocument({
        documentId,
        origin:
          query.actor.type === "user"
            ? { type: "user", actorUserId: query.actor.userId as UserId }
            : { type: "agent", actorTurnId: turn },
        mutate: (doc) => {
          const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
          const state = EditorState.create({ schema: deps.schema, doc: rootOf(doc) });
          const tr = reject(state, { turn });
          if (!tr.docChanged) return;
          rejected = true;
          const blocks: PMNode[] = [];
          tr.doc.forEach((block) => {
            blocks.push(block);
          });
          writeBlocks(fragment, deps.schema, blocks);
        },
      });
      if (!rejected) continue;
      documents.push({
        documentId,
        uri: (await deps.resolveDocumentUri(documentId)) ?? documentId,
        destination: { kind: "live" as const },
        status: "reversed" as const,
      });
    }
    const rejected = new Set(documents.map((document) => document.documentId));
    const rest = documentIds.filter((documentId) => !rejected.has(documentId));
    if (rejected.size === 0) return deps.reverseLiveTurn(query);
    if (rest.length === 0) return { status: "reversed", documents };
    const live = await deps.reverseLiveTurn({ ...query, documentIds: rest });
    return { ...live, status: "reversed", documents: [...documents, ...live.documents] };
  };
  return { reverseTurn, chip };
}
