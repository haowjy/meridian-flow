/**
 * MeridianCopilotProvider — exposes Meridian's shared thread run controller.
 *
 * Constructs one `ThreadRunController` per `ThreadTransport` so chat surfaces
 * can submit, resume, cancel, and teardown runs without AG-UI client plumbing.
 * The historical provider/context names stay as the app seam while the value is
 * now the direct transport controller.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";

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
  const controller = useMemo(
    () => new ThreadRunController({ transport, actions }),
    [actions, transport],
  );

  useEffect(() => {
    return () => {
      controller.teardown();
    };
  }, [controller]);

  return (
    <MeridianAgentContext.Provider value={controller}>{children}</MeridianAgentContext.Provider>
  );
}
