import { type AgentsLevel, agentsRootOf } from "@meridian/contracts/agents";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";

export function useAgentFileDocument(projectId: string) {
  const trees = useProjectTreeViews(projectId, AGENTS_SCHEMES, {});
  return (level: AgentsLevel, path: string): string | null => {
    const root = agentsRootOf(level);
    const tree = root.scheme === "user" ? trees.user.tree : trees.agents.tree;
    const entry = tree?.findPath(`/${[root.path, path].filter(Boolean).join("/")}`);
    return entry?.kind === "file" ? entry.documentId : null;
  };
}

export function useOpenAgentFile(projectId: string) {
  const documentOf = useAgentFileDocument(projectId);
  const open = useOpenProjectDocument(projectId);
  return (level: AgentsLevel, path: string) => {
    const documentId = documentOf(level, path);
    if (documentId) void open({ documentId, focus: true });
  };
}

const AGENTS_SCHEMES = ["agents", "user"] as const;
