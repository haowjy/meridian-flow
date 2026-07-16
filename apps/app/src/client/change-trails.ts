/** Change-trail wire model, idempotent shell reducer, and authorized HTTP reads. */
import type {
  TrailForwardAction,
  TrailForwardActionResult,
  TrailForwardActionStateV1,
} from "@meridian/contracts";
import { getJson, postJson } from "./api/http-client";

export type { TrailForwardAction, TrailForwardActionResult, TrailForwardActionStateV1 };

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
  pushId?: string | null;
  receiptId?: string | null;
  kind: "insert" | "modify" | "delete";
  beforeBlockId?: string | null;
  afterBlockId?: string | null;
  beforeBlockIdentity?: { documentId: string; clientID: number; clock: number } | null;
  beforeText: string | null;
  afterTextAtReceipt: string | null;
  /** Canonical live block retained for server-side Restore fallback planning. */
  afterBlockIdentity?: { documentId: string; clientID: number; clock: number } | null;
  navigation:
    | {
        kind: "live_block_range";
        relStart: string;
        relEnd: string;
        targetBlockId: { clientID: number; clock: number };
      }
    | {
        kind: "deletion_boundary";
        position: string;
        affinity: "before_next" | "after_previous" | "document_start";
      }
    | { kind: "unavailable"; reason: string };
  swept: null | {
    removed: { status: "available"; markdown: string } | { status: "unavailable"; reason: string };
  };
  /** Writer-protection evidence; absent on ordinary historical rows. */
  writerProtection?:
    | {
        kind: "sweep";
        body: { status: "available"; markdown: string } | { status: "unavailable"; reason: string };
      }
    | {
        kind: "resurrection";
        body: { status: "available"; markdown: string } | { status: "unavailable"; reason: string };
      };
  forwardActions?: Partial<Record<TrailForwardAction, TrailForwardActionStateV1>>;
  reversible: boolean;
};

export type ChangeTrailDocument =
  | {
      documentId: string;
      unavailable: true;
      trailId?: string;
      documentTitle?: string;
      changes?: TrailChange[];
    }
  | {
      trailId: string;
      documentId: string;
      documentTitle: string;
      changes: TrailChange[];
      unavailable?: false;
    };
export type TrailShellState = { byId: Record<string, ChangeTrailShell>; gapPending: boolean };

export const emptyTrailShellState = (): TrailShellState => ({ byId: {}, gapPending: false });

export type TrailShellTransition = {
  kind: "updated" | "settled";
  threadId: string;
  trailId: string;
  turnId: string | null;
  version: number;
  counts?: { changes: number; swept: number; documents: number };
};

/** Fold one ordered delivery fact into shell state without inventing missing counts. */
export function applyTrailShellTransition(
  state: TrailShellState,
  transition: TrailShellTransition,
  occurredAt = new Date().toISOString(),
): TrailShellState {
  const prior = state.byId[transition.trailId];
  const counts =
    transition.counts ??
    (prior
      ? {
          changes: prior.changeCount,
          swept: prior.sweptChangeCount,
          documents: prior.documentCount,
        }
      : null);
  if (!counts) return state;
  return upsertTrailShell(state, {
    trailId: transition.trailId,
    owner: transition.turnId
      ? { kind: "turn", threadId: transition.threadId, turnId: transition.turnId }
      : { kind: "shared", threadId: transition.threadId, turnId: null },
    state: transition.kind === "settled" ? "settled" : "building",
    version: transition.version,
    changeCount: counts.changes,
    sweptChangeCount: counts.swept,
    documentCount: counts.documents,
    updatedAt: occurredAt,
    settledAt: transition.kind === "settled" ? occurredAt : null,
  });
}

/** Only strictly newer transitions apply; equal/older delivery is a replay. */
export function upsertTrailShell(state: TrailShellState, shell: ChangeTrailShell): TrailShellState {
  const current = state.byId[shell.trailId];
  if (current && current.version >= shell.version) return state;
  return { ...state, byId: { ...state.byId, [shell.trailId]: shell } };
}

export function reconcileTrailShells(
  _state: TrailShellState,
  shells: ChangeTrailShell[],
): TrailShellState {
  let next: TrailShellState = { byId: {}, gapPending: false };
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

/** Forward writer actions are server-owned so validation and journal persistence share one lock. */
export async function applyTrailForwardAction(input: {
  threadId: string;
  trailId: string;
  changeId: string;
  action: TrailForwardAction;
}): Promise<TrailForwardActionResult> {
  return postJson<TrailForwardActionResult>(
    `/api/threads/${input.threadId}/change-trails/${input.trailId}/changes/${input.changeId}/${input.action}`,
    {},
  );
}
