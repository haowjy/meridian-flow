/**
 * What a document paints, in whichever host holds it: its view on this device (`document-views`),
 * the pinned owner's draft list, and the Work scope's list for the version chip.
 *
 * ```text
 * pin set, its owner's list not loaded        → pending (never Live first)
 * pin set, the list read failed               → failed (shown on the document, the pin kept)
 * pin set and its item is listed              → that draft
 * pin set and the list lacks its item         → pending, until a fresh read also lacks it and
 *                                               the pin goes (`verifyPin`); then continue
 * otherwise                                   → Live
 * ```
 *
 * The scope never chooses a draft: a document opens on Live, and `scopeDraft` only lets the chip
 * say the picked Work has one. A draft-created document is always pinned to its draft: every way
 * of opening one names it, so it never reaches Live.
 */
import { draftOwnerKey, type ThreadDraftListItem } from "@meridian/contracts/branches";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import {
  type DocumentView,
  type DraftPin,
  useDocumentView,
  verifyPin,
} from "@/client/project-shell/document-views";
import { unwrapListQuery } from "@/client/query/list-query";
import { ownerDraftsQueryOptions } from "@/client/query/useOwnerDrafts";
import type { ContextTab } from "@/client/stores";
import { useAccountId } from "./context/account-feature-context";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { useIsDraftOnly } from "./context/use-is-draft-only";

export type DocumentPaint = {
  showing: "pending" | "failed" | "draft" | "live";
  /** The draft painted; null unless `showing` is "draft". */
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

/** One owner's draft rows; a null owner has none. */
export function useOwnerDraftRows(projectId: string, ownerKey: string | null): Rows {
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
  const scopeRows = useOwnerDraftRows(projectId, scopeOwnerKey);
  const pin = view.pin;
  const pinRows = useOwnerDraftRows(
    projectId,
    pin && pin.ownerKey !== scopeOwnerKey ? pin.ownerKey : null,
  );
  const pinList = pin && pin.ownerKey === scopeOwnerKey ? scopeRows : pinRows;
  const pinListed = pin ? pinList.rows.some((row) => row.itemKey === pin.itemKey) : false;
  const pinMissing = pin !== undefined && pinList.status === "ready" && !pinListed;

  const queryClient = useQueryClient();
  const missingKey = pinMissing ? JSON.stringify([pin.ownerKey, pin.itemKey]) : null;
  const scopeRow = documentId
    ? scopeRows.rows.find((row) => row.documentId === documentId)
    : undefined;
  // A document live lacks shows "removed" only when the scope has no draft of it either: its view
  // moves to the scope's draft when the pinned one ends.
  const isDraftOnly = useIsDraftOnly(projectId);
  const successor =
    documentId && scopeOwnerKey && scopeRow && isDraftOnly(documentId)
      ? { documentId, pin: { ownerKey: scopeOwnerKey, itemKey: scopeRow.itemKey } }
      : null;
  const latestSuccessor = useRef(successor);
  latestSuccessor.current = successor;
  useEffect(() => {
    if (!pin || !missingKey) return;
    verifyPin(queryClient, accountId, projectId, pin, (id) => {
      const next = latestSuccessor.current;
      return next?.documentId === id && next.pin.itemKey !== pin.itemKey ? next.pin : null;
    });
  }, [missingKey, queryClient, accountId, projectId]);

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
      if (pinListed) return painted(pin);
      return {
        ...base,
        showing: pinList.status === "failed" ? "failed" : "pending",
        draft: null,
        outOfScope: false,
      };
    }
    return { ...base, showing: "live", draft: null, outOfScope: false };
  }, [scopeOwnerKey, scopeRow, view, pin, pinList.status, pinListed]);
}
