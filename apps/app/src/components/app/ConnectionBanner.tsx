/**
 * ConnectionBanner — transient status pill reflecting the thread transport's
 * connection state (reconnecting / degraded / terminal, plus a brief
 * "reconnected" confirmation). An open document's own pill says separately that
 * its edits are saved locally while offline.
 *
 * Subscribes to `ThreadTransport.onConnectionState` and only surfaces after a
 * real disruption. Owns the banner visibility/timer logic; the underlying
 * connection lifecycle is owned by the transport.
 */

import { Trans } from "@lingui/react/macro";
import type { ConnectionState } from "@meridian/thread-client";
import { useEffect, useRef, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RECONNECTED_VISIBLE_MS = 3_000;

type BannerKind = "reconnecting" | "degraded" | "terminal" | "reconnected";

function bannerKind(state: ConnectionState, showReconnected: boolean): BannerKind | null {
  if (showReconnected) return "reconnected";
  if (state.kind === "reconnecting") return "reconnecting";
  if (state.kind === "degraded") return "degraded";
  if (state.kind === "terminal" || state.kind === "unauthorized") return "terminal";
  return null;
}

export function ConnectionBanner() {
  const transport = useThreadTransport();
  const [state, setState] = useState<ConnectionState>({ kind: "disconnected" });
  const [showReconnected, setShowReconnected] = useState(false);
  const sawDisruptionRef = useRef(false);

  useEffect(() => {
    return transport.onConnectionState((next) => {
      setState(next);
      if (
        next.kind === "reconnecting" ||
        next.kind === "degraded" ||
        next.kind === "terminal" ||
        next.kind === "unauthorized"
      ) {
        sawDisruptionRef.current = true;
        setShowReconnected(false);
        return;
      }
      if (next.kind === "connected" && sawDisruptionRef.current) {
        sawDisruptionRef.current = false;
        setShowReconnected(true);
      }
    });
  }, [transport]);

  useEffect(() => {
    if (!showReconnected) return;
    const timer = setTimeout(() => setShowReconnected(false), RECONNECTED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [showReconnected]);

  const kind = bannerKind(state, showReconnected);
  if (!kind || kind === "terminal") return null;

  // Floats over the app instead of taking a row above it: a row that appears and goes moves
  // everything under the writer's pointer. Only the button takes clicks.
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed top-[calc(env(safe-area-inset-top)+0.5rem)] left-1/2 z-50 flex w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-2.5 text-xs font-medium shadow-float",
        kind === "reconnected"
          ? "border-primary/22 text-jade-text"
          : "border-border-subtle text-muted-foreground",
        kind !== "degraded" && "pr-2.5",
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {kind === "reconnecting" ? (
        <Trans>Reconnecting…</Trans>
      ) : kind === "degraded" ? (
        <Trans>Connection lost. Retrying…</Trans>
      ) : (
        <Trans>Reconnected</Trans>
      )}
      {kind === "degraded" ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="pointer-events-auto rounded-full"
          onClick={() => transport.reconnect()}
        >
          <Trans>Reconnect now</Trans>
        </Button>
      ) : null}
    </div>
  );
}
