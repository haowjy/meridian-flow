/**
 * SyncStatus — collaboration sync indicator pill for the document editor.
 *
 * Subscribes to a `DocumentSession` snapshot and renders at most one localized
 * label, derived from the session's status semantics (see
 * `core/editor/document-session.ts`). `synced` only means the connection is up
 * and its handshake is done, not that the server has the latest edits, so the
 * pill says nothing in healthy use:
 *   - `destroyed`   → "Closed" (session torn down); always wins
 *   - `access-lost` → "Access lost (not saving to the server)" (terminal denial); always wins
 *   - an outage → "Saved locally (offline)" (edits buffered in the browser).
 *     It begins when the status is `offline` or when `adoptionStalled` (a cached
 *     session that is `detached` because adopting it failed). It stays through
 *     the reconnect until the server has acknowledged every local change
 *     (`serverHasLocalChanges`), then swaps in place to "Back online (all
 *     changes saved)" for a few seconds and hides.
 *   - otherwise nothing: `detached` alone is not an outage (a healthy cold load
 *     spends about a second there), so there is no timer and a first load never
 *     shows a label.
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
 * change and no render exists between the two labels. Terminal states reset to
 * idle. An outage (offline, or a stalled adoption) always means awaiting. A
 * drop while confirmed (any non-synced status) returns to awaiting. A local
 * edit while confirmed (the server no longer has everything) ends the
 * confirmation and hides the pill: the connection is healthy, so it is not
 * "offline" again, and waiting to re-show the confirmation would flicker on
 * every keystroke.
 */
function nextPhase(phase: OutagePhase, snapshot: DocumentSessionSnapshot): OutagePhase {
  if (snapshot.status === "access-lost" || snapshot.status === "destroyed") return "idle";
  if (snapshot.status === "offline" || snapshot.adoptionStalled) return "awaiting";
  if (phase === "idle") return phase;
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

/** A session already offline or stalled when the pill mounts shows its label on the first render. */
function trackSession(session: DocumentSession): Tracked {
  const snapshot = session.getSnapshot();
  return { session, snapshot, phase: nextPhase("idle", snapshot) };
}

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

  // Autosync is assumed, so the healthy and transient states say nothing:
  // "no news is good news." Terminal states win over any outage phase. Rendered
  // as a quiet floating pill by EditorView.
  const label =
    snapshot.status === "destroyed" ? (
      <Trans>Closed</Trans>
    ) : snapshot.status === "access-lost" ? (
      <Trans>Access lost (not saving to the server)</Trans>
    ) : phase === "awaiting" ? (
      <Trans>Saved locally (offline)</Trans>
    ) : phase === "confirmed" ? (
      <Trans>Back online (all changes saved)</Trans>
    ) : null;
  if (!label) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-muted px-2 py-1 text-meta font-medium text-muted-foreground shadow-card"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </div>
  );
}
