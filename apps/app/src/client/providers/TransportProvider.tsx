/**
 * TransportProvider — creates and lifecycle-manages the singleton
 * `ThreadSocketClient` and exposes it via context (`useThreadTransport`).
 *
 * Connects on mount, disconnects on unmount. The single place the production
 * transport is instantiated; consumers depend on the `ThreadTransport` contract.
 */

import { t } from "@lingui/core/macro";
import type { ConnectionState, ThreadTransport } from "@meridian/thread-client";
import { ThreadSocketClient } from "@meridian/thread-client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { MeridianApiError } from "@/client/api/meridian-error";
import { cancelTurn } from "@/client/api/threads-api";
import { useFailureLog } from "@/client/failures/failure-log";
import { announce } from "@/client/stores";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { buildThreadsWsUrl } from "@/core/transport/dev-transport";
import {
  notifyThreadFrame,
  notifyThreadSocketClose,
  notifyThreadSocketOpen,
} from "@/core/transport/wire-tap";

import { useConnectivityHints } from "./ConnectivityProvider";

const ThreadTransportContext = createContext<ThreadTransport | null>(null);

export function TransportProvider({ children }: { children: ReactNode }) {
  const connectivityHints = useConnectivityHints();
  const failureLog = useFailureLog();
  const [transport] = useState(
    () =>
      new ThreadSocketClient({
        failureLog,
        url: buildThreadsWsUrl,
        webSocketFactory: (url) => new WebSocket(url),
        connectivity: connectivityHints,
        observer: DEBUG_FEATURE_ALLOWED
          ? {
              onStringFrame: notifyThreadFrame,
              onSocketOpen: notifyThreadSocketOpen,
              onSocketClose: notifyThreadSocketClose,
            }
          : undefined,
        toError: (error) => new MeridianApiError(error),
        cancelTurn: (threadId, turnId) => cancelTurn({ data: { threadId, turnId } }),
      }),
  );

  useEffect(() => {
    transport.connect();
    return () => {
      transport.disconnect("app_unmount");
    };
  }, [transport]);

  // Each composer shows the connection's state; the change is spoken once, here, through the
  // app's one live region.
  useEffect(() => {
    // A retry passes through `connecting`, which says nothing: only a new word is spoken.
    let said: string | null = null;
    return transport.onConnectionState((state) => {
      const trouble = connectionTrouble(state);
      if (trouble && trouble !== said) {
        said = trouble;
        announce(trouble);
      } else if (state.kind === "connected" && said) {
        said = null;
        announce(t`Reconnected`);
      }
    });
  }, [transport]);

  return (
    <ThreadTransportContext.Provider value={transport}>{children}</ThreadTransportContext.Provider>
  );
}

/** The words for a connection in trouble, shown in each composer and announced; null while it isn't. */
export function connectionTrouble(state: ConnectionState): string | null {
  if (state.kind === "reconnecting") return t`Reconnecting…`;
  if (state.kind === "degraded") return t`Offline`;
  return null;
}

export function useThreadTransport(): ThreadTransport {
  const transport = useOptionalThreadTransport();
  if (!transport) {
    throw new Error("useThreadTransport must be used within TransportProvider");
  }
  return transport;
}

export function useOptionalThreadTransport(): ThreadTransport | null {
  return useContext(ThreadTransportContext);
}
