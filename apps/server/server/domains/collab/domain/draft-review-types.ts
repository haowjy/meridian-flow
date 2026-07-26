/** Collab-internal draft review model; route code maps this to wire DTOs. */

export type DraftReviewOperationContribution = "added" | "removed" | "rewrote" | "edited";
export type DraftReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface DraftReviewHunkSpanInternal {
  anchorFrom: string;
  anchorTo: string;
  operationId: string;
}

type DraftReviewHunkBaseInternal = {
  hunkId: string;
  operationIds: string[];
  mergeArtifact?: boolean;
  anchor: {
    relStart: string;
    relEnd: string;
  };
};

export type DraftReviewTextHunkInternal = DraftReviewHunkBaseInternal & {
  kind: "text";
  spans: DraftReviewHunkSpanInternal[];
  deletedText?: string;
};

export type DraftReviewBlockDisplayInternal = { type: string; display: string };

export type DraftReviewBlockHunkInternal = DraftReviewHunkBaseInternal & {
  kind: "block";
  insertedBlock?: DraftReviewBlockDisplayInternal;
  deletedBlock?: DraftReviewBlockDisplayInternal;
};

export type DraftReviewHunkInternal = DraftReviewTextHunkInternal | DraftReviewBlockHunkInternal;

export interface DraftReviewOperationInternal {
  operationId: string;
  closureClassId: string;
  discardUpdateIds: number[];
  sourceUpdateIds: number[];
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
  contribution: DraftReviewOperationContribution;
  classification: DraftReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
  hunkCount: number;
}
