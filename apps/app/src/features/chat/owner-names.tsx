import { createContext, type ReactNode, useContext } from "react";
import { noOwnerNames, type OwnerNames } from "./document-display-name";

const OwnerNamesContext = createContext<OwnerNames>(noOwnerNames);

export function OwnerNamesProvider({
  names,
  children,
}: {
  names: OwnerNames;
  children: ReactNode;
}) {
  return <OwnerNamesContext.Provider value={names}>{children}</OwnerNamesContext.Provider>;
}

export function useOwnerNames(): OwnerNames {
  return useContext(OwnerNamesContext);
}
