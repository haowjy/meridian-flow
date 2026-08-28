/** Authenticated-account scope for the context removal coordinator. */

import { createContext, useContext, useInsertionEffect, useMemo } from "react";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);

export function ContextRemovalAccountProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  const lifetime = useMemo(() => {
    const coordinator = new ContextRemovalCoordinator(accountId);
    return { coordinator, lease: coordinator.createLifetimeLease() };
  }, [accountId]);
  useInsertionEffect(() => {
    lifetime.lease.resume();
    return () => {
      lifetime.lease.suspend();
      queueMicrotask(() => {
        lifetime.lease.disposeIfSuspended();
      });
    };
  }, [lifetime]);
  return (
    <ContextRemovalAccountContext.Provider value={lifetime.coordinator}>
      {children}
    </ContextRemovalAccountContext.Provider>
  );
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("ContextRemovalAccountProvider is required");
  return coordinator;
}
