/** Atomic maintenance of a holder's links and caller-owned redirect consumption. */
import type { DocumentId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { DocumentLinkSubstitution } from "../document-link-occurrences.js";
import type { DocumentDerivationCut } from "./document-derivations.js";

export type DocumentLinkMover =
  | { type: "user"; actorUserId: UserId }
  | { type: "agent"; actorTurnId: TurnId };
export type DocumentLinkRewriteClaim = {
  substitutions: ReadonlyMap<string, DocumentLinkSubstitution>;
  mover: DocumentLinkMover;
  /** Runs in the same ambient transaction, after successful certification. */
  consume(): Promise<void>;
};
export type RewriteDocumentLinks = (input: {
  documentId: DocumentId;
  /** Locks and reads caller-owned rows in the ambient transaction. */
  claim(cut: DocumentDerivationCut): Promise<DocumentLinkRewriteClaim | null>;
}) => Promise<void>;
