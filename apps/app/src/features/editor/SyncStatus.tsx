/**
 * SyncStatus — collaboration sync indicator pill for the document editor.
 *
 * Subscribes to a `DocumentSession` snapshot and renders a localized status
 * badge. Labels are derived directly from the session's status semantics
 * (see `core/editor/document-session.ts`):
 *   - `synced`    → "Synced"                  (edits are on the server)
 *   - `syncing`   → "Syncing…"                (initial / reconnect in flight)
 *   - `offline`   → "Saved locally · offline" (buffered until reconnect)
 *   - `access-lost` → "Access lost · not saving to server" (terminal denial)
 *   - `destroyed` → "Closed"                  (session torn down)
 * Pure presentational leaf; owns only the pill chrome and its subscription.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";

export type SyncStatusProps = {
  session: DocumentSession;
};

export function SyncStatus({ session }: SyncStatusProps) {
  const [snapshot, setSnapshot] = useState<DocumentSessionSnapshot>(() => session.getSnapshot());

  useEffect(() => session.subscribe(setSnapshot), [session]);

  // Autosync is assumed, so the healthy and transient states (synced, syncing)
  // say nothing — "no news is good news." We only surface a state the user
  // might actually act on: edits buffered locally while offline, or a
  // torn-down session. Rendered as a quiet floating pill by EditorView.
  if (snapshot.status === "synced" || snapshot.status === "syncing") return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-subtle px-2 py-1 text-meta font-medium text-muted-foreground shadow-card"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {snapshot.status === "offline" ? <Trans>Saved locally · offline</Trans> : null}
      {snapshot.status === "access-lost" ? <Trans>Access lost · not saving to server</Trans> : null}
      {snapshot.status === "destroyed" ? <Trans>Closed</Trans> : null}
    </div>
  );
}
