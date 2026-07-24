// Read-only host seam for a turn's folded change-trail projection.

export type TurnDiffTrailState = "building" | "settling" | "settled";

export interface TurnDiffChange {
  kind: "insert" | "modify" | "delete";
  documentId: string;
  before: string | null;
  after: string | null;
  mergedOver: Array<{ body: string; writerAuthored: boolean }>;
}

export interface TurnDiffResult {
  trailState: TurnDiffTrailState;
  changes: TurnDiffChange[];
  sharedEffects: boolean;
}

export interface TurnDiffQuery {
  query(threadId: string, turnId: string, documentId?: string): Promise<TurnDiffResult | null>;
}
