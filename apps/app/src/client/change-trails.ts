/** Change-trail wire model, idempotent shell reducer, and authorized HTTP reads. */
import { getJson } from "./api/http-client";

export type ChangeTrailShell = {
  trailId: string;
  owner:
    | { kind: "turn"; threadId: string; turnId: string }
    | { kind: "shared"; threadId: string; turnId: null };
  state: "building" | "settling" | "settled";
  version: number;
  changeCount: number;
  sweptChangeCount: number;
  documentCount: number;
  updatedAt: string;
  settledAt: string | null;
};

export type TrailChange = {
  changeId: string;
  ordinal: number;
  documentId: string | null;
  kind: "insert" | "modify" | "delete";
  beforeText: string | null;
  afterTextAtReceipt: string | null;
  navigation:
    | { kind: "live_block_range"; relStart: string; relEnd: string; targetBlockId: string }
    | {
        kind: "deletion_boundary";
        position: string;
        affinity: "before_next" | "after_previous" | "document_start";
      }
    | { kind: "unavailable"; reason: string };
  swept: null | {
    removed: { status: "available"; markdown: string } | { status: "unavailable"; reason: string };
  };
  reversible: boolean;
};
export type ChangeTrailDocument = {
  trailId: string;
  documentId: string;
  documentTitle: string;
  changes: TrailChange[];
};
export type TrailShellState = { byId: Record<string, ChangeTrailShell>; gapPending: boolean };

export const emptyTrailShellState = (): TrailShellState => ({ byId: {}, gapPending: false });

/** Versions are monotonic. Replays and out-of-order delivery are therefore no-ops. */
export function upsertTrailShell(state: TrailShellState, shell: ChangeTrailShell): TrailShellState {
  const current = state.byId[shell.trailId];
  if (current && current.version >= shell.version) return state;
  return { ...state, byId: { ...state.byId, [shell.trailId]: shell } };
}

export function reconcileTrailShells(
  state: TrailShellState,
  shells: ChangeTrailShell[],
): TrailShellState {
  let next = { ...state, gapPending: false };
  for (const shell of shells) next = upsertTrailShell(next, shell);
  return next;
}

export async function listChangeTrailShells(threadId: string): Promise<ChangeTrailShell[]> {
  const result = await getJson<{ version: 1; shells: ChangeTrailShell[] }>(
    `/api/threads/${threadId}/change-trails`,
  );
  return result.shells;
}

export async function readChangeTrail(
  threadId: string,
  trailId: string,
): Promise<ChangeTrailDocument[]> {
  const result = await getJson<{ version: 1; trailId: string; documents: ChangeTrailDocument[] }>(
    `/api/threads/${threadId}/change-trails/${trailId}`,
  );
  return result.documents;
}
