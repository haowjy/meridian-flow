/**
 * TransportProvider — creates and lifecycle-manages the singleton
 * `ThreadSocketClient` and exposes it via context (`useThreadTransport`).
 *
 * Connects on mount, disconnects on unmount. The single place the production
 * transport is instantiated; consumers depend on the `ThreadTransport` contract.
 */

import type { ThreadTransport } from "@meridian/thread-client";
import { ThreadSocketClient } from "@meridian/thread-client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { MeridianApiError } from "@/client/api/meridian-error";
import { cancelTurn } from "@/client/api/threads-api";
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
  const [transport] = useState(
    () =>
      new ThreadSocketClient({
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

  return (
    <ThreadTransportContext.Provider value={transport}>{children}</ThreadTransportContext.Provider>
  );
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
