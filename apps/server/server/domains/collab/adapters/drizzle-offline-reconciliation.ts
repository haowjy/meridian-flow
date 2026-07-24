/** Production offline-reconciliation adapter assembly. */
import { createHash } from "node:crypto";
import type {
  AgentEditCodec,
  ReversalStore,
  UpdateJournal,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { TurnId } from "@meridian/contracts/runtime";
import type { DocumentUriResolver } from "../../context/document-uri-resolver.js";
import { createOfflineReconciliation } from "../domain/offline-reconciliation.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import { documentTitleFromUri } from "../domain/reversal-notices.js";

export function createDrizzleOfflineReconciliation(input: {
  journal: UpdateJournal & ReversalStore;
  changeTrails: ChangeTrailPersistence;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  resolveTurnThreadId(
    turnId: TurnId,
  ): Promise<import("@meridian/contracts/runtime").ThreadId | null>;
  resolveDocumentUri: DocumentUriResolver;
}) {
  return createOfflineReconciliation({
    journal: input.journal,
    changeTrails: input.changeTrails,
    model: input.model,
    codec: input.codec,
    identifyUpdate: (update) => createHash("sha256").update(update).digest("hex"),
    resolveThreadId: input.resolveTurnThreadId,
    resolveDocumentTitle: async (documentId) =>
      documentTitleFromUri(await input.resolveDocumentUri(documentId)) ?? "Untitled document",
  });
}
