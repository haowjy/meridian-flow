import type { Turn } from "@meridian/contracts/protocol";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { buildSubagentRuns, indexSubagentRuns, type SubagentRunKey } from "./run-model";

const SubagentActivityContext = createContext({
  nodes: [] as ThreadActivityNode[],
  runs: indexSubagentRuns([]),
});

export function SubagentActivityProvider({
  nodes,
  turns = [],
  children,
}: {
  nodes: ThreadActivityNode[];
  turns?: Turn[];
  children: ReactNode;
}) {
  const indexed = useMemo(
    () => ({
      nodes,
      runs: indexSubagentRuns(buildSubagentRuns(nodes, turns)),
    }),
    [nodes, turns],
  );
  return (
    <SubagentActivityContext.Provider value={indexed}>{children}</SubagentActivityContext.Provider>
  );
}

export function useSubagentRun(key: SubagentRunKey) {
  const { runs } = useContext(SubagentActivityContext);
  if ("threadId" in key) return runs.byThreadId.get(key.threadId);
  if ("ref" in key) return runs.byRef.get(key.ref);
  return runs.byExecution.get(key.execution);
}

/** The provider receives the viewed thread's direct-child activity from the server. */
export function useSubagentRuns() {
  const { nodes, runs } = useContext(SubagentActivityContext);
  return nodes.map((node) => runs.byThreadId.get(node.threadId)).filter((run) => run != null);
}
