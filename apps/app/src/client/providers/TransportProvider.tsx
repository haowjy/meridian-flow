/**
 * TransportProvider — creates and lifecycle-manages the singleton
 * `WsThreadTransport` and exposes it via context (`useThreadTransport`).
 *
 * Connects on mount, disconnects on unmount. The single place the production
 * transport is instantiated; consumers depend on the `ThreadTransport` contract.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import type { ThreadTransport } from "@/core/transport";
import { WsThreadTransport } from "@/core/transport";

const ThreadTransportContext = createContext<ThreadTransport | null>(null);

export function TransportProvider({ children }: { children: ReactNode }) {
  const [transport] = useState(() => new WsThreadTransport());

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
  const transport = useContext(ThreadTransportContext);
  if (!transport) {
    throw new Error("useThreadTransport must be used within TransportProvider");
  }
  return transport;
}
