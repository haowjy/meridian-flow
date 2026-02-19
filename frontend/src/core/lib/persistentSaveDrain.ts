/**
 * Persistent save drain — retries failed document saves from IndexedDB.
 *
 * Replaces the in-memory RetryScheduler for document saves so that
 * retries survive page reload. Uses the `pendingDocumentSaves` Dexie
 * table (keyed by documentId → last-write-wins).
 *
 * Drain triggers:
 * 1. On startup (initial drain)
 * 2. On `online` event (network recovery)
 * 3. On periodic tick (configurable interval, default 5s)
 */

import { db } from "./db";
import { syncDocument } from "./sync";
import { makeLogger } from "./logger";
import { isNetworkError } from "./errors";
import type { PendingDocumentSave } from "./offlineTypes";

const log = makeLogger("persistent-save-drain");

let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

/**
 * Delete a pending row only if it still matches the drained snapshot.
 *
 * This prevents a race where a newer save is written while drain is in-flight.
 */
async function deletePendingSaveIfUnchanged(
  entry: PendingDocumentSave,
): Promise<boolean> {
  const current = await db.pendingDocumentSaves.get(entry.documentId);
  if (!current || current.createdAt !== entry.createdAt) {
    return false;
  }

  await db.pendingDocumentSaves.delete(entry.documentId);
  return true;
}

/**
 * Drain all pending saves from IndexedDB.
 *
 * For each row:
 * - on success: remove if unchanged since snapshot
 * - on transient failure (network/5xx): keep for next cycle
 * - on permanent failure (4xx/validation): remove if unchanged
 */
export async function drainPendingSaves(): Promise<void> {
  // Guard against concurrent drains
  if (draining) return;
  draining = true;

  try {
    const pending = await db.pendingDocumentSaves.toArray();
    if (pending.length === 0) return;

    log.info(`Draining ${pending.length} pending save(s)`);

    for (const entry of pending) {
      try {
        await syncDocument(entry.documentId, entry.content);
        const removed = await deletePendingSaveIfUnchanged(entry);
        if (removed) {
          log.info(`Drained pending save`, entry.documentId);
        }
      } catch (error) {
        if (isNetworkError(error)) {
          // Transient failures stay queued for the next cycle.
          log.warn("Transient failure draining save", entry.documentId, error);
          continue;
        }

        // Permanent failures (4xx/validation/etc.) are removed to avoid
        // retrying forever. Guard the delete to avoid clobbering newer edits.
        const removed = await deletePendingSaveIfUnchanged(entry);
        if (removed) {
          log.warn(
            "Permanent failure draining save, removed pending row",
            entry.documentId,
            error,
          );
        }
      }
    }
  } finally {
    draining = false;
  }
}

function onOnline() {
  log.info("Online event — draining pending saves");
  void drainPendingSaves();
}

/**
 * Start the persistent save drain.
 *
 * Runs an initial drain, then sets up a periodic tick and
 * listens for the `online` event.
 */
export function initPersistentSaveDrain(tickMs = 5000): void {
  log.info("Starting persistent save drain");

  // Initial drain on startup
  void drainPendingSaves();

  // Periodic tick
  if (!timer) {
    timer = setInterval(() => void drainPendingSaves(), tickMs);
  }

  // Drain when network comes back (browser-only)
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }
}

/**
 * Stop the persistent save drain and clean up listeners.
 */
export function cleanupPersistentSaveDrain(): void {
  log.info("Stopping persistent save drain");

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (typeof window !== "undefined") {
    window.removeEventListener("online", onOnline);
  }
}
