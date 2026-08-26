/** Deterministic browser adapters for the Work detail component fixture. */
import type { ProjectChatItem, ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import type { CreateWorkRequest, UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { useState } from "react";
import type { WorkCommand, WorkMutations } from "../../src/client/query/useWorks";
export const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
export function Trans({ children }: { children: React.ReactNode }) {
  return children;
}
export function Plural({ value, one, other }: { value: number; one: string; other: string }) {
  return (value === 1 ? one : other).replace("#", String(value));
}
export const useLingui = () => ({ i18n: { locale: "en-US" } });
export const useBlocker = () => ({
  status: "idle",
  proceed: () => undefined,
  reset: () => undefined,
});
const state = () => window.__WORK_DETAIL_FIXTURE__;
export const useWorkDrafts = () => ({
  status: "success",
  groups: state().drafts,
  refetch: () => undefined,
});
export const activeWorkDraftGroups = (groups: unknown[]) => groups;
export const useProjectContextTree = (_projectId: string, scheme: "scratch" | "uploads") => ({
  tree: state()[scheme],
  isError: false,
  refetch: () => undefined,
});
export const useWorkThreads = () => {
  const [threads, setThreads] = useState(state().threads);
  const [hasNextPage, setHasNextPage] = useState(Boolean(state().nextThreads?.length));
  return {
    threads,
    isError: false,
    isFetchingNextPage: false,
    nextPageIdentity: hasNextPage ? "next-page" : null,
    fetchNextPageFor: () => {
      setThreads((current) => [...current, ...(state().nextThreads ?? [])]);
      setHasNextPage(false);
    },
    setFavorite: async () => true,
    setUnread: async () => true,
    refetch: () => undefined,
  };
};
export const useProjectChatUserState = (_projectId: string, item: ProjectChatItem) => ({
  item,
  favorite: { pending: false as const },
  unread: { pending: false as const },
});
export const useAnnouncement = () => ({
  announce: () => undefined,
  announceError: () => undefined,
});
function browserWorkCommand<TResult, TVariables>(
  run: (variables: TVariables) => Promise<TResult>,
): WorkCommand<TResult, TVariables> {
  return {
    mutate: () => undefined,
    mutateAsync: run,
    isPending: false,
    error: null,
  };
}

export const useWorkMutations = (): WorkMutations => ({
  create: browserWorkCommand<Work, CreateWorkRequest>(async () => state().work),
  update: browserWorkCommand<Work, { workId: string; data: UpdateWorkRequest }>(
    async () => state().work,
  ),
  archive: browserWorkCommand<Work, string>(async () => state().work),
  unarchive: browserWorkCommand<Work, string>(async () => state().work),
  delete: browserWorkCommand<void, string>(async () => undefined),
  isPending: false,
});
export const useWorks = () => ({
  works: [state().work],
  isError: false,
  isFetching: false,
  refetch: () => undefined,
});

declare global {
  interface Window {
    __WORK_DETAIL_FIXTURE__: {
      work: Work;
      drafts: Array<{
        documentId: string;
        documentName: string;
        contextPath: string;
        drafts: Array<{ status: string }>;
      }>;
      scratch: ProjectContextTreeDirectory;
      uploads: ProjectContextTreeDirectory;
      threads: ProjectChatItem[];
      nextThreads?: ProjectChatItem[];
    };
  }
}
