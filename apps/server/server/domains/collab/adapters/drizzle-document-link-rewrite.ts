/** Journal-locked link maintenance with atomic derivation and after-commit publication. */

import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents, documentYjsHeads } from "@meridian/database";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  type DrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { deriveDocumentOutputs } from "../domain/document-derivations.js";
import { applyDocumentLinkSubstitutions } from "../domain/document-link-occurrences.js";
import { admitFreshAuthorship } from "../domain/document-mutation-policy.js";
import type { RewriteDocumentLinks } from "../domain/ports/document-link-rewrite.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import {
  captureDocumentDerivation,
  certifyDocumentDerivation,
} from "./drizzle-document-derivations.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

export function createDrizzleDocumentLinkRewrite(input: {
  db: Database;
  resolveUri(tx: DrizzleDb, documentId: DocumentId): Promise<string | null>;
  serializer: DurableProjectionSerializer;
  publish(documentId: DocumentId, update: Uint8Array): void | Promise<void>;
}): RewriteDocumentLinks {
  return ({ documentId, claim }) =>
    runInDrizzleTransaction(input.db, async () => {
      const tx = currentDrizzleDb(input.db);
      await lockDocumentMutation(tx, documentId);
      await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, documentId))
        .for("no key update");
      const cut = await captureDocumentDerivation(tx, documentId, input.resolveUri);
      if (!cut) return;
      const claimed = await claim(cut);
      if (!claimed) return;
      const base = createCollabYDoc({ gc: false });
      const rewritten = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(base, cut.state);
        Y.applyUpdate(rewritten, cut.state);
        applyDocumentLinkSubstitutions(
          rewritten.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
          claimed.substitutions,
        );
        const update = Y.encodeStateAsUpdate(rewritten, Y.encodeStateVector(base));
        const journal = createDrizzleJournal(input.db);
        await admitFreshAuthorship(
          {
            readMutationTarget: () => ({
              documentId,
              generation: cut.watermark.generation,
              doc: base,
            }),
            admitImmediate: async ({ update }) => {
              const seq = await journal.append(documentId, update, {
                origin: "link-update",
                seq: 0,
                ...(claimed.mover.type === "user"
                  ? { actorUserId: claimed.mover.actorUserId }
                  : { actorTurnId: claimed.mover.actorTurnId }),
              });
              return { sequence: BigInt(seq), joined: 0 };
            },
          },
          { source: { kind: "writer" }, update },
        );
        const [head] = await tx
          .select()
          .from(documentYjsHeads)
          .where(eq(documentYjsHeads.documentId, documentId));
        if (!head) throw new Error("Missing rewritten document head");
        const rewrittenCut = {
          ...cut,
          watermark: { ...cut.watermark, admissionSequence: head.nextAdmissionSequence },
        };
        const outputs = await deriveDocumentOutputs(rewrittenCut, rewritten, input.serializer);
        if (!(await certifyDocumentDerivation(tx, rewrittenCut, outputs, new Date())))
          throw new Error("Link rewrite certification rejected");
        await claimed.consume();
        deferUntilDrizzleCommit(() => input.publish(documentId, update));
      } finally {
        base.destroy();
        rewritten.destroy();
      }
    });
}
