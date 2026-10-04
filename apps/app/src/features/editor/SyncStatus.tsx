/**
 * SyncStatus — collaboration sync indicator pill for the document editor.
 *
 * Subscribes to a `DocumentSession` snapshot and renders a localized status
 * badge. Labels are derived directly from the session's status semantics
 * (see `core/editor/document-session.ts`):
 *   - `detached`  → no indicator              (a local-only document, or the instant before
 *                                              transport attaches); a server-backed document
 *                                              still detached after a beat reads as offline
 *   - `synced`    → "Synced"                  (edits are on the server)
 *   - `syncing`   → "Syncing…"                (initial / reconnect in flight)
 *   - `offline`   → "Saved locally (offline)" (buffered until reconnect)
 *   - `access-lost` → "Access lost (not saving to the server)" (terminal denial)
 *   - `destroyed` → "Closed"                  (session torn down)
 * Pure presentational leaf; owns only the pill chrome and its subscription.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";

export type SyncStatusProps = {
  session: DocumentSession;
  /** The document lives on the server, so a session that never attaches is not "local by design". */
  serverBacked?: boolean;
};

/** Normal transport attach takes well under this; past it, detached is a state to show. */
const DETACHED_GRACE_MS = 1000;

export function SyncStatus({ session, serverBacked = false }: SyncStatusProps) {
  const [snapshot, setSnapshot] = useState<DocumentSessionSnapshot>(() => session.getSnapshot());
  const detached = serverBacked && snapshot.status === "detached";
  const [detachedLong, setDetachedLong] = useState(false);

  useEffect(() => session.subscribe(setSnapshot), [session]);
  useEffect(() => {
    if (!detached) {
      setDetachedLong(false);
      return;
    }
    const timer = window.setTimeout(() => setDetachedLong(true), DETACHED_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [detached]);

  // Autosync is assumed, so the healthy and transient states (synced, syncing)
  // say nothing — "no news is good news." We only surface a state the user
  // might actually act on: edits buffered locally while offline, or a
  // torn-down session. Rendered as a quiet floating pill by EditorView.
  const visible =
    snapshot.status === "detached"
      ? detachedLong
      : snapshot.status === "offline" ||
        snapshot.status === "access-lost" ||
        snapshot.status === "destroyed";
  if (!visible) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-muted px-2 py-1 text-meta font-medium text-muted-foreground shadow-card"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {snapshot.status === "offline" || snapshot.status === "detached" ? (
        <Trans>Saved locally (offline)</Trans>
      ) : null}
      {snapshot.status === "access-lost" ? (
        <Trans>Access lost (not saving to the server)</Trans>
      ) : null}
      {snapshot.status === "destroyed" ? <Trans>Closed</Trans> : null}
    </div>
  );
}
