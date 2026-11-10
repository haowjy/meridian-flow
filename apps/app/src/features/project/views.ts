/**
 * What a document paints, in whichever host holds it: its view on this device (`document-views`),
 * the pinned owner's draft list, and the Work scope's list for the version chip.
 *
 * ```text
 * the pinned owner's list not loaded, or a pin being checked → pending (never Live first)
 * pin set and its item is listed                              → that draft
 * pin set and a fresh read lacks it                           → the pin goes; continue
 * a draft-created document                                    → its owner's draft
 * otherwise                                                   → Live
 * ```
 *
 * The scope never chooses a draft: a document opens on Live, and `scopeDraft` only lets the chip
 * say the picked Work has one.
 */
import { draftOwnerKey, type ThreadDraftListItem } from "@meridian/contracts/branches";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import {
  type DocumentView,
  type DraftPin,
  useDocumentView,
  useVerifyingPin,
  verifyPin,
} from "@/client/project-shell/document-views";
import { unwrapListQuery } from "@/client/query/list-query";
import { ownerDraftsQueryOptions } from "@/client/query/useOwnerDrafts";
import { type ContextTab, isDraftOnly, reviewEntryOf, reviewOwnerOfTab } from "@/client/stores";
import { useAccountId } from "./context/account-feature-context";
import { useContextRemovalProject } from "./context/use-context-removal-project";

export type DocumentPaint = {
  showing: "pending" | "draft" | "live";
  /** The draft painted; null while pending or on Live. */
  draft: DraftPin | null;
  /** The painted draft's owner is not the scope's. */
  outOfScope: boolean;
  /** The Work scope's draft owner, whose draft the chip offers; null under No Work. */
  scopeOwnerKey: string | null;
  /** The scope's draft of this document, whether or not it is painted. */
  scopeDraft: DraftPin | null;
  view: DocumentView;
};

type Rows = { status: "loading" | "ready" | "failed"; rows: readonly ThreadDraftListItem[] };
const NO_ROWS: readonly ThreadDraftListItem[] = [];

function useOwnerRows(projectId: string, ownerKey: string | null): Rows {
  const list = unwrapListQuery(
    useQuery({
      ...ownerDraftsQueryOptions(projectId, ownerKey ?? ""),
      select: (response) => response.items,
      enabled: projectReadEnabled(ownerKey !== null),
    }),
  );
  return useMemo(
    () =>
      ownerKey === null || list.status === "disabled"
        ? { status: "ready", rows: NO_ROWS }
        : list.status === "error"
          ? { status: "failed", rows: NO_ROWS }
          : list.data === null
            ? { status: "loading", rows: NO_ROWS }
            : { status: "ready", rows: list.data },
    [ownerKey, list.status, list.data],
  );
}

export function useDocumentPaint(projectId: string, document: ContextTab | null): DocumentPaint {
  const accountId = useAccountId();
  const documentId = document?.documentId ?? null;
  const view = useDocumentView(accountId, projectId, documentId);
  const { activeWorkId } = useContextRemovalProject(projectId);
  const scopeOwnerKey = activeWorkId ? draftOwnerKey({ kind: "work", workId: activeWorkId }) : null;
  const scopeRows = useOwnerRows(projectId, scopeOwnerKey);
  const pin = view.pin;
  const pinRows = useOwnerRows(
    projectId,
    pin && pin.ownerKey !== scopeOwnerKey ? pin.ownerKey : null,
  );
  const pinList = pin && pin.ownerKey === scopeOwnerKey ? scopeRows : pinRows;
  const checking = useVerifyingPin(accountId, projectId, pin);
  const pinListed = pin ? pinList.rows.some((row) => row.itemKey === pin.itemKey) : false;
  const pinMissing = pin !== undefined && pinList.status === "ready" && !pinListed;

  const queryClient = useQueryClient();
  const missingKey = pinMissing ? JSON.stringify([pin.ownerKey, pin.itemKey]) : null;
  useEffect(() => {
    if (pin && missingKey) verifyPin(queryClient, accountId, projectId, pin);
  }, [missingKey, queryClient, accountId, projectId]);

  const scopeRow = documentId
    ? scopeRows.rows.find((row) => row.documentId === documentId)
    : undefined;
  return useMemo((): DocumentPaint => {
    const scopeDraft =
      scopeOwnerKey && scopeRow ? { ownerKey: scopeOwnerKey, itemKey: scopeRow.itemKey } : null;
    const base = { scopeOwnerKey, scopeDraft, view };
    const painted = (draft: DraftPin): DocumentPaint => ({
      ...base,
      showing: "draft",
      draft,
      outOfScope: draft.ownerKey !== scopeOwnerKey,
    });
    if (pin) {
      if (pinList.status === "loading" || (checking && !pinListed))
        return { ...base, showing: "pending", draft: null, outOfScope: false };
      if (pinListed) return painted(pin);
    }
    if (document && isDraftOnly(document)) {
      const ownerKey =
        scopeOwnerKey && reviewEntryOf(document, scopeOwnerKey)
          ? scopeOwnerKey
          : reviewOwnerOfTab(document, activeWorkId);
      const entry = ownerKey ? reviewEntryOf(document, ownerKey) : undefined;
      if (ownerKey && entry) return painted({ ownerKey, itemKey: entry.itemKey });
    }
    return { ...base, showing: "live", draft: null, outOfScope: false };
  }, [
    scopeOwnerKey,
    scopeRow,
    view,
    pin,
    pinList.status,
    checking,
    pinListed,
    document,
    activeWorkId,
  ]);
}
