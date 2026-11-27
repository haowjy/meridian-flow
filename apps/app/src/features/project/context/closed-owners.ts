import type { ContextSource } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEndedSources, useProjectContextSources } from "@/client/query/useContextSources";
import { useWorks } from "@/client/query/useWorks";
import type { ClosedOwner, ClosedOwners } from "@/core/project-tree/tree-undo";
import { workStateIn } from "../work/work-state";

type Read = {
  works: readonly Work[] | null;
  deleted: readonly Work[];
  nameOf: (work: Work) => string;
  sources: readonly ContextSource[] | undefined;
  ended: ReadonlySet<string> | null;
};

type Shared = { read: Read | null; reader: ClosedOwners };

const projects = new WeakMap<QueryClient, Map<string, Shared>>();

export function useClosedOwners(projectId: string): ClosedOwners {
  const queryClient = useQueryClient();
  const { works, deleted, nameOf } = useWorks(projectId, { enabled: Boolean(projectId) });
  const sources = useProjectContextSources(projectId);
  const ended = useEndedSources(projectId);
  const shared = sharedOf(queryClient, projectId);
  shared.read = { works, deleted, nameOf, sources, ended };
  return shared.reader;
}

function sharedOf(queryClient: QueryClient, projectId: string): Shared {
  let byProject = projects.get(queryClient);
  if (!byProject) {
    byProject = new Map();
    projects.set(queryClient, byProject);
  }
  const found = byProject.get(projectId);
  if (found) return found;
  const shared: Shared = {
    read: null,
    reader: {
      source: (sourceId) => {
        const { sources, ended } = shared.read ?? {};
        if (ended?.has(sourceId)) return { why: "chat_frozen" };
        const source = sources?.find((one) => one.id === sourceId);
        return source ? ownerOf(source) : null;
      },
    },
  };
  const workClosed = (workId: string): ClosedOwner | null => {
    if (!shared.read) return null;
    const state = workStateIn(shared.read, workId);
    return state.kind === "ended"
      ? {
          why: state.deleted ? "work_deleted" : "work_archived",
          owner: shared.read.nameOf(state.work),
        }
      : null;
  };
  const ownerOf = ({ owner }: ContextSource): ClosedOwner | null =>
    owner.kind === "work" ? workClosed(owner.workId) : null;
  byProject.set(projectId, shared);
  return shared;
}
