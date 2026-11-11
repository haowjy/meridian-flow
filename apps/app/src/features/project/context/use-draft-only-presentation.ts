/**
 * Whether a document is one live lacks, shown through its draft. The evidence is the draft the
 * document's view pins: its server row says the draft created the document or live deleted it
 * (`isNew`, `deletedLive`), or live deleted it just now while the draft was held open. Every way
 * of opening a draft-created document pins its draft, so the pin is always there.
 *
 * A host mount that saw the evidence presents the document under its own token and stays
 * draft-only until settlement promotes it: a draft that ends (a Discard) must not send the host
 * to a live room the server refuses before settlement closes it.
 */
import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { type DraftPin, useDocumentView } from "@/client/project-shell/document-views";
import type { ContextTab } from "@/client/stores";
import { useOwnerDraftRows } from "../views";
import { useAccountId, useOptionalDraftOnlyPresentations } from "./account-feature-context";
import type { EditableContextTab } from "./ContextDocumentHost";

export type DocumentLiveness = "live" | "draft-only" | "pending";

const subscribeNothing = () => () => undefined;

/** Whether a document is draft-only now (`DraftOnlyPresentations`); re-renders when that changes. */
export function useIsDraftOnly(projectId: string): (documentId: string) => boolean {
  const registry = useOptionalDraftOnlyPresentations();
  const version = useSyncExternalStore(
    registry?.subscribe ?? subscribeNothing,
    () => registry?.version ?? 0,
    () => 0,
  );
  return useCallback(
    (documentId: string) => registry?.isDraftOnly(projectId, documentId) ?? false,
    [registry, projectId, version],
  );
}

/** The pinned draft's evidence that live lacks the document; `pending` while its row is unread. */
function usePinnedDraftEvidence(
  projectId: string,
  tab: ContextTab | null,
): { pin: DraftPin | undefined; evidence: boolean; pending: boolean } {
  const accountId = useAccountId();
  const isDraftOnly = useIsDraftOnly(projectId);
  const view = useDocumentView(accountId, projectId, tab?.documentId ?? null);
  const pin = tab?.kind === "tracked" ? view.pin : undefined;
  const rows = useOwnerDraftRows(projectId, pin?.ownerKey ?? null);
  const row = pin ? rows.rows.find((candidate) => candidate.itemKey === pin.itemKey) : undefined;
  const held = !!pin && !!tab && isDraftOnly(tab.documentId);
  return {
    pin,
    evidence: !!pin && (!!row?.isNew || !!row?.deletedLive || held),
    pending: !!pin && rows.status === "loading",
  };
}

/** For a reader that is not the document's host (the recents record, the identity bar). */
export function useDocumentLiveness(projectId: string, tab: ContextTab | null): DocumentLiveness {
  const { evidence, pending } = usePinnedDraftEvidence(projectId, tab);
  return evidence ? "draft-only" : pending ? "pending" : "live";
}

/** The host's own: presents its document while draft-only, under a token minted per mount. */
export function useDraftOnlyPresentation(
  projectId: string,
  tab: EditableContextTab,
): DocumentLiveness {
  const registry = useOptionalDraftOnlyPresentations();
  const [token] = useState(() => crypto.randomUUID());
  const documentId = tab.documentId;
  const { pin, evidence, pending } = usePinnedDraftEvidence(projectId, tab);
  const state = useSyncExternalStore(
    registry?.subscribe ?? subscribeNothing,
    () => registry?.state(token) ?? "absent",
    () => "absent" as const,
  );
  const scheme = tab.kind === "tracked" ? tab.scheme : null;
  const path = tab.kind === "tracked" ? tab.path : null;
  useLayoutEffect(() => {
    if (!registry || !pin || !scheme || path === null || !evidence || state === "promoted") return;
    registry.present({
      projectId,
      documentId,
      ownerKey: pin.ownerKey,
      itemKey: pin.itemKey,
      token,
      contextLocation: { scheme, path },
    });
  }, [registry, evidence, state, projectId, documentId, pin?.ownerKey, pin?.itemKey, scheme, path]);
  useLayoutEffect(() => () => registry?.withdraw(token), [registry, token]);
  if (state === "draft-only" || (evidence && state !== "promoted")) return "draft-only";
  return pending ? "pending" : "live";
}
