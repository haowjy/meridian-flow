/** Deterministic browser adapters for the Work detail component fixture. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import type { WorkCommand, WorkMutations } from "../../src/client/query/useWorks";
export const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
export const msg = t;
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
export const useContextCatalogView = (_projectId: string, scheme: "scratch" | "uploads") => ({
  catalog: {
    root: { entryId: "root" },
    files: () => state()[scheme].filter((node) => node.kind === "file"),
    children: () => state()[scheme],
  },
  isError: false,
  refetch: () => undefined,
});
export const useProjectChatFeed = () => {
  const threads = state().threads;
  return {
    items: threads,
    data: { pages: [{ items: threads, nextCursor: null }] },
    isPending: false,
    isError: false,
    isPlaceholderData: false,
    hasNextPage: false,
    refetch: () => undefined,
  };
};
export const useProjectChatUserState = (_projectId: string, item: ProjectChatItem) => ({
  item,
  favorite: { pending: false as const },
});
export const useAnnouncement = () => ({
  announce: () => undefined,
  announceError: () => undefined,
});
export const announceError = () => undefined;
export const useIsThreadPendingCreation = () => false;
export const useThreadActions = () => ({});
export const commitContextAvailability = () => undefined;
export const commitDraftApplyMetadata = () => undefined;
export const commitPlannedContextRemoval = () => undefined;
export const commitReviewOverlayClose = () => undefined;
export const getContextTabs = () => [];
export const previewReviewOverlayClose = () => ({ status: "unchanged" });
export const useContextTabsActions = () => ({});
export const accessibleResourceCatalogView = () => null;
export const contextCatalogScope = () => null;
export const projectCatalogFile = () => null;
export const projectCatalogView = () => null;
function browserWorkCommand<TResult, TVariables>(
  run: (variables: TVariables) => Promise<TResult>,
): WorkCommand<TResult, TVariables> {
  return {
    mutate: () => undefined,
    mutateAsync: run,
  };
}

export const useWorkMutations = (): WorkMutations => ({
  update: browserWorkCommand<Work, { workId: string; data: UpdateWorkRequest }>(
    async () => state().work,
  ),
  archive: browserWorkCommand<Work, string>(async () => state().work),
  unarchive: browserWorkCommand<Work, string>(async () => state().work),
  delete: browserWorkCommand<void, string>(async () => undefined),
  restore: browserWorkCommand<Work, string>(async () => state().work),
});
export const useWorkCommandFailures = () => new Map();
export const useRestoringWorkIds = () => new Set<string>();
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
      scratch: Array<{ kind: "file" | "dir"; name: string; path: string }>;
      uploads: Array<{ kind: "file" | "dir"; name: string; path: string }>;
      threads: ProjectChatItem[];
      nextThreads?: ProjectChatItem[];
    };
  }
}
