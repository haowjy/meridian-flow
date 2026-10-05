/** Authenticated-shell owner of the browser's shared connectivity hints. */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ConnectivityHints, type ConnectivityHintsPort } from "@/core/transport/connectivity-hints";

const ConnectivityContext = createContext<ConnectivityHintsPort | undefined>(undefined);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [hints] = useState(() =>
    typeof window === "undefined"
      ? undefined
      : new ConnectivityHints({
          browser: window,
          document: window.document,
          now: () => Date.now(),
          random: () => Math.random(),
          setTimeout: globalThis.setTimeout.bind(globalThis),
          clearTimeout: globalThis.clearTimeout.bind(globalThis),
        }),
  );
  useEffect(() => {
    hints?.start();
    return () => hints?.stop();
  }, [hints]);
  return <ConnectivityContext.Provider value={hints}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivityHints(): ConnectivityHintsPort | undefined {
  return useContext(ConnectivityContext);
}
