import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo } from "react";
import { useAccountEpochSignal, useAccountId } from "@/client/account/account-context";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useThreadActions } from "@/client/stores";

import { ThreadRunController } from "./ThreadRunController";

const MeridianAgentContext = createContext<ThreadRunController | null>(null);

export function useMeridianAgent(): ThreadRunController {
  const controller = useContext(MeridianAgentContext);
  if (!controller) {
    throw new Error("useMeridianAgent must be used within MeridianCopilotProvider");
  }
  return controller;
}

export function MeridianCopilotProvider({ children }: { children: ReactNode }) {
  const transport = useThreadTransport();
  const actions = useThreadActions();
  const accountSignal = useAccountEpochSignal();
  const accountId = useAccountId();
  const controller = useMemo(
    () =>
      new ThreadRunController({
        transport,
        actions,
        accountSignal,
        accountId,
      }),
    [actions, transport, accountSignal, accountId],
  );

  useLayoutEffect(() => {
    controller.activate();
    return () => {
      controller.dispose();
    };
  }, [controller]);

  return (
    <MeridianAgentContext.Provider value={controller}>{children}</MeridianAgentContext.Provider>
  );
}
