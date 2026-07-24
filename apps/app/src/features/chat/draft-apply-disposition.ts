/** draft-apply-disposition — one revision and response policy for every Apply entry point. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";
import type { InlineReviewMessage } from "./draft-review-controller-transitions";

export type DraftApplyScope = "draft" | "operation";

export type DraftApplyPreview = {
  documentId: string;
  draftId: string;
  operationIds: readonly string[];
  draftRevisionToken: number;
  branchId?: string;
};

type LatestDraftPreviewRevision = {
  operationIds: readonly string[];
  draftRevisionToken: number;
  branchId?: string;
};

export type DraftApplyRequest = {
  draftId: string;
  operationIds: string[];
  draftRevisionToken: number;
  branchId?: string;
};

export type DraftApplyDisposition = {
  transition:
    | { kind: "draft"; response: DraftAcceptResponse }
    | { kind: "operation"; message: InlineReviewMessage };
  refreshDraftId: string | null;
  materializedDocument: boolean;
};

export function acquireDraftApplyRequest(input: {
  scope: "draft";
  preview: DraftApplyPreview;
}): DraftApplyRequest;
export function acquireDraftApplyRequest(input: {
  scope: "operation";
  draftId: string;
  operationId: string;
  loadLatestPreview: () => Promise<LatestDraftPreviewRevision>;
}): Promise<DraftApplyRequest>;
export function acquireDraftApplyRequest(
  input:
    | { scope: "draft"; preview: DraftApplyPreview }
    | {
        scope: "operation";
        draftId: string;
        operationId: string;
        loadLatestPreview: () => Promise<LatestDraftPreviewRevision>;
      },
): DraftApplyRequest | Promise<DraftApplyRequest> {
  if (input.scope === "operation") {
    return input.loadLatestPreview().then((preview) =>
      requestFromPreview({
        ...preview,
        draftId: input.draftId,
        operationIds: [input.operationId],
      }),
    );
  }
  return requestFromPreview(input.preview);
}

function requestFromPreview(preview: Omit<DraftApplyPreview, "documentId">): DraftApplyRequest {
  return {
    draftId: preview.draftId,
    ...(preview.branchId ? { branchId: preview.branchId } : {}),
    draftRevisionToken: preview.draftRevisionToken,
    operationIds: [...preview.operationIds],
  };
}

export function dispositionForDraftApply(
  scope: DraftApplyScope,
  response: DraftAcceptResponse,
): DraftApplyDisposition {
  const refreshDraftId = response.status === "stale_draft" ? response.draftId : null;
  const materializedDocument =
    response.status === "applied" ||
    (scope === "operation" && response.status === "partial_applied");

  if (scope === "operation" && response.status === "partial_applied") {
    return {
      transition: {
        kind: "operation",
        message: { code: "change-applied", writeId: response.writeId },
      },
      refreshDraftId,
      materializedDocument,
    };
  }
  if (scope === "operation" && response.status === "stale_draft") {
    return {
      transition: {
        kind: "operation",
        message: { code: "changes-moved-refreshed" },
      },
      refreshDraftId,
      materializedDocument,
    };
  }
  return {
    transition: { kind: "draft", response },
    refreshDraftId,
    materializedDocument,
  };
}
