/** Project-scoped command channel for starting creation in the desktop context tree. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { ContextCreateKind } from "./context-create-kind";

export type TreeCreationRequest = {
  scheme: ProjectContextTreeScheme;
  kind: ContextCreateKind;
  /** Target folder path (`""` = scheme root) the inline create row nests under. */
  parentPath: string;
};
type TreeCreationController = {
  request: TreeCreationRequest | null;
  requestCreate: (request: TreeCreationRequest) => void;
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
  const [request, setRequest] = useState<TreeCreationRequest | null>(null);
  const value = useMemo<TreeCreationController>(
    () => ({
      request,
      requestCreate: (nextRequest) => {
        expandSidebar();
        setRequest(nextRequest);
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
