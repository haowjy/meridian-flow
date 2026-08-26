/** Deterministic browser adapters for mounting the production Work detail boundary. */
import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
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
export const useWorkThreads = () => ({
  threads: state().threads,
  isError: false,
  isFetchingNextPage: false,
  nextPageIdentity: null,
  fetchNextPageFor: () => undefined,
  setFavorite: async () => true,
  setUnread: async () => true,
  getCommandState: () => ({ pending: false as const, error: null }),
  refetch: () => undefined,
});
export const useAnnouncement = () => ({
  announce: () => undefined,
  announceError: () => undefined,
});
export const useWorkMutations = () => ({
  mutateAsync: async () => state().work,
  mutate: () => undefined,
  isPending: false,
  error: null,
  reset: () => undefined,
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
      threads: Array<{
        id: string;
        title: string;
        work: { id: string; title: string } | null;
        lastMessagePreview: string | null;
        lastActivityAt: string;
        attention: "none" | "unread" | "actionRequired";
        isFavorite: boolean;
      }>;
    };
  }
}
