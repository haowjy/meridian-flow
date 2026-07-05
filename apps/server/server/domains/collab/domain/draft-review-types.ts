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

export type DraftReviewDirectionalClosure = {
  accept: { operationIds?: string[]; updateIds: number[] };
  reject: { operationIds?: string[]; updateIds: number[] };
};

export interface DraftReviewOperationInternal {
  operationId: string;
  acceptClosureOperationIds?: string[];
  rejectClosureOperationIds?: string[];
  rejectSourceUpdateIds: number[];
  sourceUpdateIds: number[];
  directionalClosure: DraftReviewDirectionalClosure;
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
  contribution: DraftReviewOperationContribution;
  classification: DraftReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
  hunkCount: number;
}
