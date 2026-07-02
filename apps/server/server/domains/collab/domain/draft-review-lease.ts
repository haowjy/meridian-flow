/** Tracks draft review leases from draft-room WebSocket presence. */
import type { UserId } from "@meridian/contracts/runtime";

export const DEFAULT_DRAFT_REVIEW_GRACE_MS = 30_000;

type TimerHandle = unknown;

type DraftPresence = {
  connections: Map<string, UserId>;
  releaseTimer?: TimerHandle;
};

export type DraftReviewLease = {
  enter(input: { draftId: string; socketId: string; userId: UserId }): void;
  leave(input: { draftId: string; socketId: string }): void;
  isUnderReview(draftId: string): boolean;
  connectedCount(draftId: string): number;
};

export function createDraftReviewLease(
  options: {
    graceMs?: number;
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (timer: TimerHandle) => void;
  } = {},
): DraftReviewLease {
  const graceMs = options.graceMs ?? DEFAULT_DRAFT_REVIEW_GRACE_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: TimerHandle) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const drafts = new Map<string, DraftPresence>();

  function presenceFor(draftId: string): DraftPresence {
    const existing = drafts.get(draftId);
    if (existing) return existing;
    const created: DraftPresence = { connections: new Map() };
    drafts.set(draftId, created);
    return created;
  }

  function cancelRelease(presence: DraftPresence): void {
    if (!presence.releaseTimer) return;
    clearTimer(presence.releaseTimer);
    delete presence.releaseTimer;
  }

  function scheduleRelease(draftId: string, presence: DraftPresence): void {
    if (presence.releaseTimer) return;
    presence.releaseTimer = setTimer(() => {
      const current = drafts.get(draftId);
      if (!current || current.connections.size > 0) return;
      drafts.delete(draftId);
    }, graceMs);
  }

  return {
    enter({ draftId, socketId, userId }) {
      const presence = presenceFor(draftId);
      cancelRelease(presence);
      presence.connections.set(socketId, userId);
    },

    leave({ draftId, socketId }) {
      const presence = drafts.get(draftId);
      if (!presence) return;
      presence.connections.delete(socketId);
      if (presence.connections.size === 0) scheduleRelease(draftId, presence);
    },

    isUnderReview(draftId) {
      return drafts.has(draftId);
    },

    connectedCount(draftId) {
      return drafts.get(draftId)?.connections.size ?? 0;
    },
  };
}
