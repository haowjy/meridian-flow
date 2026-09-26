import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { createContext, type ReactNode, useContext } from "react";

const SubagentActivityContext = createContext<ThreadActivityNode[]>([]);

export function SubagentActivityProvider({
  nodes,
  children,
}: {
  nodes: ThreadActivityNode[];
  children: ReactNode;
}) {
  return (
    <SubagentActivityContext.Provider value={nodes}>{children}</SubagentActivityContext.Provider>
  );
}

export function useSubagentActivity(
  threadId: string | null | undefined,
): ThreadActivityNode | undefined {
  const nodes = useContext(SubagentActivityContext);
  return threadId ? nodes.find((node) => node.threadId === threadId) : undefined;
}

export function useSubagentActivityByRef(
  ref: string | null | undefined,
): ThreadActivityNode | undefined {
  const nodes = useContext(SubagentActivityContext);
  return ref ? nodes.find((node) => node.ref === ref) : undefined;
}

export function useSubagentActivityNodes(): ThreadActivityNode[] {
  return useContext(SubagentActivityContext);
}
