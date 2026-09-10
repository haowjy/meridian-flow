/** React composition seam for the authenticated account's first-send continuity. */
import { createContext, useContext, useMemo } from "react";
import { FirstSendContinuity } from "./first-send-continuity";

const Context = createContext<FirstSendContinuity | null>(null);

export function FirstSendContinuityProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  const continuity = useMemo(() => new FirstSendContinuity(accountId), [accountId]);
  return <Context.Provider value={continuity}>{children}</Context.Provider>;
}

export function useFirstSendContinuity(): FirstSendContinuity {
  const continuity = useContext(Context);
  if (!continuity) throw new Error("FirstSendContinuityProvider is required");
  return continuity;
}
