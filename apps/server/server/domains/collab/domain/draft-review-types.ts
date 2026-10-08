/** Journal-extended public review operations; presentation types live in contracts. */
import type { ReviewOperation } from "@meridian/contracts/drafts";

declare const sourceUpdateIdBrand: unique symbol;
declare const physicalSourceUpdateIdBrand: unique symbol;

export type SourceUpdateId = number & { readonly [sourceUpdateIdBrand]: true };
export type PhysicalSourceUpdateId = number & {
  readonly [physicalSourceUpdateIdBrand]: true;
};
export type SourceUpdateIds = SourceUpdateId[];
export type PhysicalSourceUpdateIds = PhysicalSourceUpdateId[];

export function asSourceUpdateIds(updateIds: readonly number[]): SourceUpdateIds {
  return [...updateIds] as SourceUpdateIds;
}

export function asPhysicalSourceUpdateIds(updateIds: readonly number[]): PhysicalSourceUpdateIds {
  return [...updateIds] as PhysicalSourceUpdateIds;
}

export type DraftReviewOperationInternal = ReviewOperation & {
  sourceUpdateIds: SourceUpdateIds;
  closureUpdateIds: PhysicalSourceUpdateIds;
};

export type DraftReviewDiagnostic = { code: "unattributed_hunk"; hunkId: string };
