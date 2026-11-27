import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";

const SAVED_CONFIRMATION_VISIBLE_MS = 3_000;

type OutagePhase = "idle" | "awaiting" | "confirmed";

function nextPhase(
  phase: OutagePhase,
  snapshot: DocumentSessionSnapshot,
  deliverable: boolean,
): OutagePhase {
  if (!deliverable) return "idle";
  if (snapshot.status === "offline") return "awaiting";
  if (phase === "idle") return phase;
  if (phase === "awaiting") return snapshot.serverHasLocalChanges ? "confirmed" : "awaiting";
  if (snapshot.status !== "synced") return "awaiting";
  return snapshot.serverHasLocalChanges ? "confirmed" : "idle";
}

type Tracked = {
  session: DocumentSession;
  snapshot: DocumentSessionSnapshot;
  phase: OutagePhase;
};

function trackSession(session: DocumentSession): Tracked {
  const snapshot = session.getSnapshot();
  return { session, snapshot, phase: nextPhase("idle", snapshot, session.canDeliverUnsentEdits()) };
}

export function SyncStatus({ session }: { session: DocumentSession }) {
  const [stored, setStored] = useState<Tracked>(() => trackSession(session));

  let tracked = stored;
  if (stored.session !== session) {
    tracked = trackSession(session);
    setStored(tracked);
  }
  const { snapshot, phase } = tracked;

  useEffect(
    () =>
      session.subscribe((next) => {
        const deliverable = session.canDeliverUnsentEdits();
        setStored((current) =>
          current.session === session
            ? { session, snapshot: next, phase: nextPhase(current.phase, next, deliverable) }
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

  const removed =
    snapshot.connectionState?.kind === "reset" &&
    snapshot.connectionState.disposition === "removed";
  const label = removed ? null : snapshot.status === "destroyed" ? (
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
    <div className="inline-flex items-center gap-1.5 font-medium" role="status" aria-live="polite">
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </div>
  );
}
