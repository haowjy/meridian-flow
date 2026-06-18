/**
 * ConnectionBanner — transient banner reflecting the thread transport's
 * connection state (reconnecting / degraded / terminal, plus a brief
 * "reconnected" confirmation).
 *
 * Subscribes to `ThreadTransport.onConnectionState` and only surfaces after a
 * real disruption. Owns the banner visibility/timer logic; the underlying
 * connection lifecycle is owned by the transport.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { useThreadTransport } from "@/client/providers/TransportProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ConnectionState } from "@/core/transport";
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
  if (!kind) return null;

  const toneClassName =
    kind === "terminal"
      ? "border-destructive bg-card text-destructive"
      : kind === "reconnected"
        ? "border-status-done-bg bg-status-done-bg text-status-done-foreground"
        : "border-border bg-status-live-bg text-status-live-foreground";

  return (
    <Alert
      role="status"
      aria-live="polite"
      className={cn(
        "grid-cols-1 shrink-0 rounded-none border-x-0 border-t-0 border-b px-4 py-2 shadow-none",
        toneClassName,
      )}
    >
      <AlertDescription className="col-start-1 text-current">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <span>
            {kind === "reconnecting" && state.kind === "reconnecting" ? (
              <Trans>Reconnecting… attempt {state.attempt}</Trans>
            ) : kind === "degraded" && state.kind === "degraded" ? (
              <Trans>Connection lost. Retrying… attempt {state.attempt}</Trans>
            ) : kind === "terminal" ? (
              <Trans>Session expired. Please refresh.</Trans>
            ) : (
              <Trans>Reconnected</Trans>
            )}
          </span>
          {kind === "degraded" ? (
            <button
              type="button"
              className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground shadow-button transition hover:bg-surface-subtle"
              onClick={() => transport.reconnect()}
            >
              <Trans>Reconnect now</Trans>
            </button>
          ) : null}
          {kind === "terminal" ? (
            <button
              type="button"
              className="rounded-full border border-destructive px-3 py-1 text-xs font-medium transition hover:bg-surface-subtle"
              onClick={() => window.location.reload()}
            >
              <Trans>Refresh</Trans>
            </button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
