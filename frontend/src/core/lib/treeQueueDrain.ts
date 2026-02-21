/**
 * Tree queue drain — replays pending tree mutations from IndexedDB to the server.
 *
 * Reads coalesced ops from `pendingTreeOps`, replays each to the REST API,
 * and handles error responses per the phase 4.7 conflict resolution strategy:
 * - 2xx: remove op from Dexie
 * - 404: entity deleted server-side → drop op, continue
 * - 409: conflict → drop op, stop drain, refresh tree
 * - 4xx: permanent failure → drop op, continue
 * - 5xx / network: transient → stop drain, keep for next cycle
 *
 * Drain triggers:
 * 1. On startup (initial drain — handles ops surviving page reload)
 * 2. On `online` event (network recovery)
 * 3. On periodic safety-net tick (default 30s)
 */

import { api } from "@/core/lib/api";
import { isNetworkError, isAppError, ErrorType } from "@/core/lib/errors";
import { makeLogger } from "@/core/lib/logger";
import type { PendingTreeOp } from "@/core/lib/offlineTypes";
import {
  getAllPendingOps,
  coalesceOps,
  removePendingOp,
} from "@/core/services/treeSyncService";
import { useTreeStore } from "@/core/stores/useTreeStore";

const log = makeLogger("tree-queue-drain");

let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

/**
 * Replay a single tree op to the server API.
 *
 * Converts the stored op back into the appropriate API call.
 * Move ops with folderId "" are converted to null (move-to-root convention
 * established in slice 4).
 */
async function replayOp(op: PendingTreeOp): Promise<void> {
  switch (op.opType) {
    case "rename": {
      const { name } = op.params;
      if (op.entityType === "document") {
        await api.documents.rename(op.entityId, op.projectId, name);
      } else {
        await api.folders.rename(op.entityId, op.projectId, name);
      }
      break;
    }
    case "move": {
      // Convert empty string back to null (move-to-root convention from slice 4)
      const folderId = op.params.folderId === "" ? null : op.params.folderId;
      if (op.entityType === "document") {
        await api.documents.move(op.entityId, op.projectId, folderId);
      } else {
        await api.folders.move(op.entityId, op.projectId, folderId);
      }
      break;
    }
    case "delete": {
      if (op.entityType === "document") {
        await api.documents.delete(op.entityId);
      } else {
        await api.folders.delete(op.entityId);
      }
      break;
    }
  }
}

/**
 * Refresh the tree for a project, but only if it's the currently loaded project.
 *
 * Bypasses the 30s freshness check so loadTree always fetches from server.
 * Skips silently if the project is not currently loaded — the tree will be
 * refreshed naturally when the user navigates to that project.
 */
async function refreshTreeIfCurrent(projectId: string): Promise<void> {
  const currentProjectId = useTreeStore.getState().treeProjectId;
  if (currentProjectId !== projectId) return;

  useTreeStore.setState({ treeLoadedAt: null });
  try {
    await useTreeStore.getState().loadTree(projectId);
  } catch (err) {
    // Best-effort: don't block drain on tree refresh failure
    log.warn("Tree refresh failed during drain", err);
  }
}

/**
 * Drain all pending tree ops from IndexedDB.
 *
 * 1. Load all pending ops (FIFO by auto-increment id)
 * 2. Coalesce redundant ops to reduce API calls
 * 3. Remove superseded ops from Dexie
 * 4. Pre-drain: refresh tree from server (current project only)
 * 5. Replay each coalesced op with error-specific handling
 * 6. Post-drain: refresh tree from server to reconcile
 */
export async function drainPendingTreeOps(): Promise<void> {
  // Guard against concurrent drains — JS is single-threaded so
  // no await between check and set means this is race-safe.
  if (draining) return;
  draining = true;

  try {
    const allOps = await getAllPendingOps();
    if (allOps.length === 0) return;

    log.info(`Draining ${allOps.length} pending tree op(s)`);

    // Coalesce to reduce redundant API calls
    const coalesced = coalesceOps(allOps);

    // Remove superseded ops from Dexie (those eliminated by coalescing)
    const coalescedIds = new Set(coalesced.map((op) => op.id));
    for (const op of allOps) {
      if (op.id !== undefined && !coalescedIds.has(op.id)) {
        await removePendingOp(op.id);
      }
    }

    if (coalesced.length < allOps.length) {
      log.info(`Coalesced ${allOps.length} ops down to ${coalesced.length}`);
    }

    // Pre-drain: refresh tree to get authoritative server state.
    // Only refreshes the currently loaded project to avoid switching the UI.
    const projectIds = [...new Set(coalesced.map((op) => op.projectId))];
    for (const pid of projectIds) {
      await refreshTreeIfCurrent(pid);
    }

    // Drain coalesced ops in FIFO order
    let drainedAny = false;
    for (const op of coalesced) {
      try {
        await replayOp(op);
        // Success (2xx): remove from Dexie
        if (op.id !== undefined) await removePendingOp(op.id);
        drainedAny = true;
        log.info(`Drained ${op.opType} ${op.entityType}`, op.entityId);
      } catch (error) {
        if (isNetworkError(error)) {
          // Transient (5xx / network): stop drain, keep remaining ops for next cycle
          log.warn("Network error during drain, stopping", op.entityId, error);
          break;
        }

        if (isAppError(error) && error.type === ErrorType.NotFound) {
          // 404: entity deleted server-side while offline — drop and continue
          if (op.id !== undefined) await removePendingOp(op.id);
          log.warn(
            `Entity not found (404), dropping ${op.opType} ${op.entityType}`,
            op.entityId,
          );
          continue;
        }

        if (isAppError(error) && error.type === ErrorType.Conflict) {
          // 409: conflict — drop this op, stop drain, refresh tree
          if (op.id !== undefined) await removePendingOp(op.id);
          log.warn(
            `Conflict (409) during drain, dropping op and stopping`,
            op.entityId,
          );
          await refreshTreeIfCurrent(op.projectId);
          break;
        }

        // Other permanent failures (400, 403, etc.): drop op, continue draining
        if (op.id !== undefined) await removePendingOp(op.id);
        log.error(
          `Permanent failure, dropping ${op.opType} ${op.entityType}`,
          op.entityId,
          error,
        );
      }
    }

    // Post-drain: refresh tree to reconcile optimistic state with server
    if (drainedAny) {
      for (const pid of projectIds) {
        await refreshTreeIfCurrent(pid);
      }
    }
  } finally {
    draining = false;
  }
}

function onOnline() {
  log.info("Online event — draining pending tree ops");
  void drainPendingTreeOps();
}

/**
 * Start the tree queue drain.
 *
 * Runs an initial drain, then sets up a periodic safety-net tick
 * and listens for the `online` event.
 */
export function initTreeQueueDrain(tickMs = 30_000): void {
  log.info("Starting tree queue drain");

  // Initial drain on startup (handles ops surviving page reload)
  void drainPendingTreeOps();

  // Periodic safety-net tick (in case the `online` event is missed)
  if (!timer) {
    timer = setInterval(() => void drainPendingTreeOps(), tickMs);
  }

  // Drain when network comes back (browser-only)
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }
}

/**
 * Stop the tree queue drain and clean up listeners.
 */
export function cleanupTreeQueueDrain(): void {
  log.info("Stopping tree queue drain");

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (typeof window !== "undefined") {
    window.removeEventListener("online", onOnline);
  }
}
