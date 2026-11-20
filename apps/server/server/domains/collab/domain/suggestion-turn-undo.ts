/**
 * Suggestion mode (prototype): the card's Undo of a turn whose edits are still suggestions rejects
 * them, as a client of the document would: read the stored document, reject the turn's marks, write
 * the blocks back. Text the writer typed beside them is untouched. A turn that left no suggestion
 * (it wrote Live) is undone the existing way.
 */
import { writeBlocks } from "@meridian/agent-edit/diff";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { reject } from "@meridian/suggestions";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type * as Y from "yjs";
import type { DocumentWriteOrigin } from "../contracts.js";
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
}) {
  return async (query: Query): Promise<ReversalOutcome> => {
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
          const state = EditorState.create({
            schema: deps.schema,
            doc: yXmlFragmentToProseMirrorRootNode(fragment, deps.schema),
          });
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
    if (documents.length === 0) return deps.reverseLiveTurn(query);
    return { status: "reversed", documents };
  };
}
