/**
 * MeridianCopilotProvider — exposes Meridian's shared thread run controller.
 *
 * Constructs one `ThreadRunController` per `ThreadTransport` so chat surfaces
 * can submit, resume, cancel, and teardown runs without AG-UI client plumbing.
 * The historical provider/context names stay as the app seam while the value is
 * now the direct transport controller.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useThreadActions } from "@/client/stores";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

import { type RunFollowStatus, ThreadRunController } from "./ThreadRunController";

const MeridianAgentContext = createContext<ThreadRunController | null>(null);

export function useMeridianAgent(): ThreadRunController {
  const controller = useContext(MeridianAgentContext);
  if (!controller) {
    throw new Error("useMeridianAgent must be used within MeridianCopilotProvider");
  }
  return controller;
}

/** Whether the run controller follows work for this chat (the composer's working state and Stop). */
export function useRunFollowStatus(threadId: string): RunFollowStatus {
  const controller = useMeridianAgent();
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribeRunFollowStatus(listener),
    [controller],
  );
  const read = useCallback(() => controller.runFollowStatus(threadId), [controller, threadId]);
  return useSyncExternalStore(subscribe, read, read);
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
