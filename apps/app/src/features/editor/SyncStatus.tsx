/**
 * SyncStatus — collaboration sync indicator pill for the document editor.
 *
 * Subscribes to a `DocumentSession` snapshot and renders a localized status
 * badge. Labels are derived from the session's status semantics (see
 * `core/editor/document-session.ts`). `synced` only means the connection is up
 * and its handshake is done, not that the server has the latest edits, so the
 * pill says nothing in healthy use:
 *   - `detached` / `synced` / `syncing` → no indicator
 *   - `offline`   → "Saved locally (offline)" (buffered until reconnect)
 *   - after an outage, the offline label stays through the reconnect until the
 *     server has acknowledged every local change (`serverHasLocalChanges`),
 *     then it swaps in place to "Back online (all changes saved)" for a few
 *     seconds and hides. Never shown on a first load.
 *   - `access-lost` → "Access lost (not saving to the server)" (terminal denial)
 *   - `destroyed` → "Closed"                  (session torn down)
 * Pure presentational leaf; owns only the pill chrome, its subscription, and
 * the confirmation timer.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";

/** Matches ConnectionBanner's RECONNECTED_VISIBLE_MS. */
const SAVED_CONFIRMATION_VISIBLE_MS = 3_000;

/** idle: never offline (or confirmation done); awaiting: offline seen, server not yet caught up. */
type OutagePhase = "idle" | "awaiting" | "confirmed";

/**
 * Advance on every snapshot, so the offline→confirmation swap is one state
 * change and no render exists between the two labels. A drop while confirmed
 * (any non-synced status) returns to awaiting. A local edit while confirmed
 * (the server no longer has everything) ends the confirmation and hides the
 * pill: the connection is healthy, so it is not "offline" again, and waiting to
 * re-show the confirmation would flicker on every keystroke.
 */
function nextPhase(phase: OutagePhase, snapshot: DocumentSessionSnapshot): OutagePhase {
  if (snapshot.status === "offline") return "awaiting";
  if (phase === "idle") return phase;
  if (snapshot.status === "access-lost" || snapshot.status === "destroyed") return "idle";
  if (phase === "awaiting") return snapshot.serverHasLocalChanges ? "confirmed" : "awaiting";
  if (snapshot.status !== "synced") return "awaiting";
  return snapshot.serverHasLocalChanges ? "confirmed" : "idle";
}

/** Everything derived from one session's history; never carried to another session. */
type Tracked = {
  session: DocumentSession;
  snapshot: DocumentSessionSnapshot;
  phase: OutagePhase;
};

const trackSession = (session: DocumentSession): Tracked => ({
  session,
  snapshot: session.getSnapshot(),
  phase: "idle",
});

export type SyncStatusProps = {
  session: DocumentSession;
};

export function SyncStatus({ session }: SyncStatusProps) {
  const [stored, setStored] = useState<Tracked>(() => trackSession(session));

  // A new session starts from its own snapshot with no outage history. Reset
  // during render (React re-renders before committing) so the old session's
  // label and timer never reach the screen for the new one.
  let tracked = stored;
  if (stored.session !== session) {
    tracked = trackSession(session);
    setStored(tracked);
  }
  const { snapshot, phase } = tracked;

  useEffect(
    () =>
      session.subscribe((next) => {
        setStored((current) =>
          current.session === session
            ? { session, snapshot: next, phase: nextPhase(current.phase, next) }
            : current,
        );
      }),
    [session],
  );

  useEffect(() => {
    if (phase !== "confirmed") return;
    const timer = setTimeout(
      () =>
        setStored((current) =>
          current.session === session ? { ...current, phase: "idle" } : current,
        ),
      SAVED_CONFIRMATION_VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [phase, session]);

  const { status } = snapshot;
  const terminal = status === "access-lost" || status === "destroyed";
  const savedOffline = status === "offline" || (phase === "awaiting" && !terminal);
  const confirmed = phase === "confirmed" && !terminal;

  // Autosync is assumed, so the healthy and transient states say nothing —
  // "no news is good news." We only surface a state the user might actually
  // act on: edits buffered locally while offline (and the all-clear after),
  // or a torn-down session. Rendered as a quiet floating pill by EditorView.
  if (!savedOffline && !confirmed && !terminal) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-muted px-2 py-1 text-meta font-medium text-muted-foreground shadow-card"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {savedOffline ? <Trans>Saved locally (offline)</Trans> : null}
      {confirmed ? <Trans>Back online (all changes saved)</Trans> : null}
      {status === "access-lost" ? <Trans>Access lost (not saving to the server)</Trans> : null}
      {status === "destroyed" ? <Trans>Closed</Trans> : null}
    </div>
  );
}
