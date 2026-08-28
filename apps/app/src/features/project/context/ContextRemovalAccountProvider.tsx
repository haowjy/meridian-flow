/** Authenticated-account scope for the context removal coordinator. */

import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);

export function ContextRemovalAccountProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  const coordinator = useMemo(() => new ContextRemovalCoordinator(accountId), [accountId]);
  useLayoutEffect(() => () => coordinator.dispose(), [coordinator]);
  return (
    <ContextRemovalAccountContext.Provider value={coordinator}>
      {children}
    </ContextRemovalAccountContext.Provider>
  );
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("ContextRemovalAccountProvider is required");
  return coordinator;
}
