/**
 * lifecycle — maps a thread's row projection (status + waitingForUser +
 * runningTurnId) to the presentation-layer lifecycle state used across the
 * project workspace, plus its display label/styling.
 *
 * Single source for the lifecycle vocabulary
 * (`grilling` / `executing` / `waiting` / `interrupt` / `completed` / `idle`);
 * `grilling` and `completed` are fixture overlays until the orchestrator
 * surfaces them. Pure mapping; consumed by thread/work UI.
 */
import { t } from "@lingui/core/macro";
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";

/**
 * Visual lifecycle states used throughout the project workspace.
 *
 * - `executing` — a turn is actively running (`runningTurnId` set or
 *   `status === "active"`).
 * - `waiting` — the assistant has finished and the thread is waiting on the
 *   user (`waitingForUser === true` on the projection).
 * - `interrupt` — `status === "blocked"` (server-side interrupt).
 * - `errored` — `status === "error"` (the orchestrator failed the run). A
 *   needs-attention terminal state — must NOT collapse into `idle`.
 * - `grilling` / `completed` — reserved overlay states.
 * - `idle` — default rest state.
 */
export type LifecycleState =
  | "grilling"
  | "executing"
  | "waiting"
  | "interrupt"
  | "errored"
  | "completed"
  | "idle";

/**
 * Lifecycle hints lifted from a thread row projection. Both fields are
 * optional so callers that only have a base `Thread` still get a sensible
 * lifecycle (falling back to `lifecycleFromStatus`).
 */
export type LifecycleHints = {
  status: Thread["status"];
  waitingForUser?: boolean;
  runningTurnId?: string | null;
};

/** Map a thread row's projection to a presentation-layer lifecycle state. */
export function lifecycleFor(thread: Thread | ThreadListItem): LifecycleState {
  const hints: LifecycleHints = {
    status: thread.status,
    waitingForUser: "waitingForUser" in thread ? thread.waitingForUser : undefined,
    runningTurnId: "runningTurnId" in thread ? thread.runningTurnId : undefined,
  };
  return lifecycleFromHints(hints);
}

/**
 * Lifecycle for a thread row from full hints. A live `runningTurnId`
 * dominates — the row is executing even if `status` lags. Then
 * `waitingForUser` (needs-attention affordance), then the raw status.
 */
export function lifecycleFromHints(hints: LifecycleHints): LifecycleState {
  if (hints.runningTurnId) return "executing";
  if (hints.waitingForUser) return "waiting";
  return lifecycleFromStatus(hints.status);
}

/** Back-compat: derive a lifecycle from raw status only (no row projection). */
export function lifecycleFromStatus(status: Thread["status"]): LifecycleState {
  switch (status) {
    case "active":
      return "executing";
    case "blocked":
      return "interrupt";
    case "error":
      return "errored";
    case "idle":
      return "idle";
    // TODO(archive-delete): archived currently masquerades as idle. Once archive
    // is "made real" (see ThreadStatus in @meridian/contracts), give it its own
    // lifecycle state + display and route archived chats to the Archived view
    // rather than the default list.
    case "archived":
      return "idle";
    default: {
      const _exhaust: never = status;
      return _exhaust;
    }
  }
}

export type DraftIndicatorDisplay = {
  label: string;
  className: string;
  iconClassName: string;
};

/** Token-driven display for the additive draft-review chip beside lifecycle badges.
 *  Grammar-safe label: singular vs plural + optional doc-name orientation. */
export function draftIndicatorDisplay(
  count: number,
  documentName?: string | null,
): DraftIndicatorDisplay | null {
  if (count <= 0) return null;
  return {
    label: buildDraftIndicatorLabel(count, documentName ?? null),
    className:
      "inline-flex items-center gap-1 rounded-full bg-chip-primary-bg px-1.5 py-0.5 text-fine font-semibold tabular-nums text-primary",
    iconClassName: "size-3",
  };
}

function buildDraftIndicatorLabel(count: number, documentName: string | null): string {
  if (documentName) {
    return count === 1
      ? t`1 AI change pending on ${documentName}`
      : t`${count} AI changes pending on ${documentName}`;
  }
  return count === 1 ? t`1 AI change pending` : t`${count} AI changes pending`;
}

export type LifecycleDisplay = {
  /** Short label for the badge. */
  label: string;
  /** Tailwind classes for the badge background + text colour. */
  badgeClass: string;
  /** Tailwind class for the leading dot/status icon colour. */
  dotClass: string;
};

/**
 * Token-driven badge styling — keeps lifecycle styling in one place.
 *
 * Labels are computed via Lingui `t` macro so catalogs catch them.
 */
export function lifecycleDisplay(state: LifecycleState): LifecycleDisplay {
  switch (state) {
    case "executing":
      return {
        label: t`Working…`,
        badgeClass: "bg-chip-primary-bg text-primary",
        dotClass: "text-primary",
      };
    case "grilling":
      return {
        label: t`Grilling`,
        badgeClass: "bg-chip-primary-bg text-primary",
        dotClass: "text-primary",
      };
    case "waiting":
      return {
        label: t`Waiting for you`,
        badgeClass: "bg-status-live-bg text-status-live-foreground",
        dotClass: "text-status-live-foreground",
      };
    case "interrupt":
      return {
        label: t`Needs your answer`,
        badgeClass: "bg-destructive-tint text-destructive",
        dotClass: "text-destructive",
      };
    case "errored":
      return {
        label: t`Errored`,
        badgeClass: "bg-destructive-tint text-destructive",
        dotClass: "text-destructive",
      };
    case "completed":
      return {
        label: t`Completed`,
        badgeClass: "bg-status-done-bg text-status-done-foreground",
        dotClass: "text-status-done-foreground",
      };
    case "idle":
      return {
        label: t`Idle`,
        badgeClass: "bg-chip-muted-bg text-ink-subtle",
        dotClass: "text-ink-subtle",
      };
  }
}
