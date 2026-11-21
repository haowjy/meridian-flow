/**
 * Whether a document is one live lacks, shown through a Work's draft. The evidence is the draft the
 * document's view pins: its server row says the Work created the document (`isNew`). Every way
 * of opening a Work-created document pins its draft, so the pin is always there.
 */
import { useDocumentView } from "@/client/project-shell/document-views";
import type { OpenDocument } from "@/client/stores";
import { useOwnerDraftRows } from "../views";
import { useAccountId } from "./account-feature-context";

export type DocumentLiveness = "live" | "draft-only" | "pending";

/** `pending` while the pinned row is unread or unlisted. */
export function useDocumentLiveness(projectId: string, tab: OpenDocument | null): DocumentLiveness {
  const accountId = useAccountId();
  const view = useDocumentView(accountId, projectId, tab?.documentId ?? null);
  const pin = tab?.kind === "tracked" ? view.pin : undefined;
  const rows = useOwnerDraftRows(projectId, pin?.ownerKey ?? null);
  const row = pin ? rows.rows.find((candidate) => candidate.itemKey === pin.itemKey) : undefined;
  if (!pin) return "live";
  if (row?.isNew) return "draft-only";
  // A pinned item the list lacks waits, as its paint does: the row can still be on its way (a
  // reader that just mounted, a draft just made), and a stale pin ends (`verifyPin`).
  return rows.status === "loading" || (rows.status === "ready" && !row) ? "pending" : "live";
}
