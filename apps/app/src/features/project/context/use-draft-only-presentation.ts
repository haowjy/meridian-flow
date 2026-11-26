import { useDocumentView } from "@/client/project-shell/document-views";
import type { OpenDocument } from "@/client/stores";
import { useOwnerDraftRows } from "../views";
import { useAccountId } from "./account-feature-context";

export type DocumentLiveness = "live" | "draft-only" | "pending";

export function useDocumentLiveness(projectId: string, tab: OpenDocument | null): DocumentLiveness {
  const accountId = useAccountId();
  const view = useDocumentView(accountId, projectId, tab?.documentId ?? null);
  const pin = tab?.kind === "tracked" ? view.pin : undefined;
  const rows = useOwnerDraftRows(projectId, pin?.draftId ?? null);
  const row = pin ? rows.rows.find((candidate) => candidate.itemKey === pin.itemKey) : undefined;
  if (!pin) return "live";
  if (row?.isNew) return "draft-only";
  return rows.status === "loading" || (rows.status === "ready" && !row) ? "pending" : "live";
}
