/** Project-scoped command channel for starting creation in the desktop context tree. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { ContextCreateKind } from "./context-create-kind";

type CreationRequest = { scheme: ProjectContextTreeScheme; kind: ContextCreateKind };
type TreeCreationController = {
  request: CreationRequest | null;
  requestCreate: (scheme: ProjectContextTreeScheme, kind: ContextCreateKind) => void;
  completeCreate: () => void;
};

const TreeCreationContext = createContext<TreeCreationController | null>(null);

export function TreeCreationProvider({
  children,
  expandSidebar,
}: {
  children: ReactNode;
  expandSidebar: () => void;
}) {
  const [request, setRequest] = useState<CreationRequest | null>(null);
  const value = useMemo<TreeCreationController>(
    () => ({
      request,
      requestCreate: (scheme, kind) => {
        expandSidebar();
        setRequest({ scheme, kind });
      },
      completeCreate: () => setRequest(null),
    }),
    [expandSidebar, request],
  );
  return <TreeCreationContext.Provider value={value}>{children}</TreeCreationContext.Provider>;
}

export function useOptionalTreeCreation(): TreeCreationController | null {
  return useContext(TreeCreationContext);
}
