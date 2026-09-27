import type { Turn } from "@meridian/contracts/protocol";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { buildSubagentRuns, indexSubagentRuns, type SubagentRunKey } from "./run-model";

const SubagentActivityContext = createContext({
  nodes: [] as ThreadActivityNode[],
  byThreadId: new Map<string, ThreadActivityNode>(),
  byRef: new Map<string, ThreadActivityNode>(),
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
      byThreadId: new Map(nodes.map((node) => [node.threadId, node])),
      byRef: new Map(nodes.flatMap((node) => (node.ref ? [[node.ref, node] as const] : []))),
      runs: indexSubagentRuns(buildSubagentRuns(nodes, turns)),
    }),
    [nodes, turns],
  );
  return (
    <SubagentActivityContext.Provider value={indexed}>{children}</SubagentActivityContext.Provider>
  );
}

export function useSubagentActivity(
  threadId: string | null | undefined,
): ThreadActivityNode | undefined {
  const { byThreadId } = useContext(SubagentActivityContext);
  return threadId ? byThreadId.get(threadId) : undefined;
}

export function useSubagentActivityByRef(
  ref: string | null | undefined,
): ThreadActivityNode | undefined {
  const { byRef } = useContext(SubagentActivityContext);
  return ref ? byRef.get(ref) : undefined;
}

export function useSubagentActivityNodes(): ThreadActivityNode[] {
  return useContext(SubagentActivityContext).nodes;
}

export function useSubagentRun(key: SubagentRunKey) {
  const { runs } = useContext(SubagentActivityContext);
  if ("threadId" in key) return runs.byThreadId.get(key.threadId);
  if ("ref" in key) return runs.byRef.get(key.ref);
  return runs.byExecution.get(key.execution);
}

export function useSubagentRuns(
  threadId: string,
  { directOnly = false }: { directOnly?: boolean } = {},
) {
  const { nodes, runs } = useContext(SubagentActivityContext);
  const included = new Set([threadId]);
  const descendants: ThreadActivityNode[] = [];
  for (const node of nodes) {
    if (
      directOnly
        ? node.parentThreadId === threadId
        : node.parentThreadId != null && included.has(node.parentThreadId)
    ) {
      descendants.push(node);
      if (!directOnly) included.add(node.threadId);
    }
  }
  return descendants.map((node) => runs.byThreadId.get(node.threadId)).filter((run) => run != null);
}
