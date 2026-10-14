/**
 * Live's certified cut: its content and the revision that content reflects, from one durable
 * materialization (S1). The journal read captures the authority line, the checkpoint and the retained
 * updates in one pass, and the revision is that read's own watermark. A warm room is never consulted:
 * a socket admission is durable before the room applies it, so the journal is never behind a room, and a
 * revision read apart from the content it labels could certify text the base never read.
 */

import { readBlocks } from "@meridian/agent-edit/diff";
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { draftSchema, type LiveCutReader } from "../domain/draft-rebase.js";

export function createLiveCutReader(journal: Pick<UpdateJournal, "read">): LiveCutReader {
  return {
    async read(documentId) {
      const snapshot = await journal.read(documentId);
      const authority = snapshot.authority;
      if (!authority || snapshot.persistenceWatermark === undefined) return null;
      const doc = createCollabYDoc({ gc: false });
      try {
        if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
        for (const entry of [...snapshot.updates].sort((a, b) => a.seq - b.seq)) {
          Y.applyUpdate(doc, entry.update);
        }
        return {
          revision: {
            authorityId: authority.authorityId,
            authorityGeneration: authority.generation.toString(),
            seq: snapshot.persistenceWatermark,
          },
          blocks: readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema),
        };
      } finally {
        doc.destroy();
      }
    },
  };
}
