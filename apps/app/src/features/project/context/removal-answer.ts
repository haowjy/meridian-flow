import type { DocumentStanding } from "@/core/tree-list/standing";

export type RemovalAnswer = { kind: "removed"; inTrash: boolean } | { kind: "available" };

const AVAILABLE: RemovalAnswer = { kind: "available" };
const IN_TRASH: RemovalAnswer = { kind: "removed", inTrash: true };
const GONE: RemovalAnswer = { kind: "removed", inTrash: false };

export function removalAnswer(standing: DocumentStanding): RemovalAnswer | undefined {
  switch (standing.kind) {
    case "waiting":
      return undefined;
    case "in-tree":
      return AVAILABLE;
    case "in-trash":
      return IN_TRASH;
    case "purged":
    case "not-in-list":
      return GONE;
  }
}
