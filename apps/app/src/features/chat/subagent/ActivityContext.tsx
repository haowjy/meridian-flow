import type { ThreadActivityNode } from "@meridian/contracts/threads";
import {
  sameSubagentFacts,
  type TurnSubagentFacts,
  turnSubagentFacts,
} from "@meridian/thread-client";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useShared } from "../useShared";
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
  turns?: Parameters<typeof buildSubagentRuns>[1];
  children: ReactNode;
}) {
  const next = {
    nodes,
    turns,
    facts: turns.map(turnSubagentFacts).filter(hasSubagentFacts),
  };
  const shared = useShared(next, sameProviderInput);
  const indexed = useMemo(
    () => ({
      nodes: shared.nodes,
      runs: indexSubagentRuns(buildSubagentRuns(shared.nodes, shared.turns)),
    }),
    [shared],
  );
  return (
    <SubagentActivityContext.Provider value={indexed}>{children}</SubagentActivityContext.Provider>
  );
}

function hasSubagentFacts(facts: TurnSubagentFacts): boolean {
  return facts.invocations.length > 0 || facts.completion !== null || facts.failures.length > 0;
}

function sameProviderInput(
  left: {
    nodes: ThreadActivityNode[];
    turns: Parameters<typeof buildSubagentRuns>[1];
    facts: TurnSubagentFacts[];
  },
  right: {
    nodes: ThreadActivityNode[];
    turns: Parameters<typeof buildSubagentRuns>[1];
    facts: TurnSubagentFacts[];
  },
): boolean {
  return (
    left.nodes === right.nodes &&
    left.facts.length === right.facts.length &&
    left.facts.every((facts, index) => {
      const other = right.facts[index];
      return other ? sameSubagentFacts(facts, other) : false;
    })
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
