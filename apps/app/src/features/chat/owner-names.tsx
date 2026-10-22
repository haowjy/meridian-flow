/**
 * The chat's source of owner names: what a Scratch or Uploads address's handle (`@w3`, `@c12`)
 * is called on screen. The project shell supplies it; outside one, every owner is unnamed and
 * locations fall back to the area alone ("Scratch").
 */
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
