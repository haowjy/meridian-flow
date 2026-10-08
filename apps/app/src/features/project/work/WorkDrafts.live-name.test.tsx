// @vitest-environment jsdom
/** A draft row names its document as the catalog does now, not as the list was read. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkDrafts } from "./WorkDrafts";

const api = vi.hoisted(() => ({ listWorkDrafts: vi.fn() }));
vi.mock("@/client/api/drafts-api", () => api);

// The tree's catalog is the owner of a document's current name and path; this
// stands in for it as a store the hook subscribes to, like the replica.
const live = vi.hoisted(() => {
  type File = { uri: string; path: string };
  let files = new Map<string, File>();
  const listeners = new Set<() => void>();
  return {
    snapshot: () => files,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(id: string, file: File) {
      files = new Map(files).set(id, file);
      for (const listener of listeners) listener();
    },
    reset: () => {
      files = new Map();
    },
  };
});
vi.mock("@/client/query/useContextCatalog", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  return {
    useContextCatalogView: () => {
      const files = useSyncExternalStore(live.subscribe, live.snapshot);
      return { catalog: useMemo(() => ({ findDocument: (id: string) => files.get(id) }), [files]) };
    },
  };
});
vi.mock("../dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));

const draft = (documentId: string, documentName: string): ThreadDraftListItem => ({
  draftId: `draft-${documentId}`,
  documentId,
  documentName,
  contextPath: `/${documentName}.md`,
  status: "active",
  lastActorTurnId: null,
  actorThreads: [],
  updatedAt: "2026-10-01T00:00:00.000Z",
  wordsAdded: 3,
  wordsRemoved: 0,
});

describe("WorkDrafts row label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    live.reset();
    api.listWorkDrafts.mockResolvedValue({
      drafts: [draft("doc-a", "rp-a"), draft("doc-new", "fresh")],
    });
  });

  it("follows a rename immediately and keeps a draft-only document's recorded name", async () => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <I18nProvider i18n={i18n}>
          <WorkDrafts
            projectId="project-a"
            workId={"work-a" as ParsedRequestId}
            matchesSearch={() => true}
          />
        </I18nProvider>
      </QueryClientProvider>
    );
    const labels = () =>
      [...document.querySelectorAll("button span.truncate")].map((node) => node.textContent);
    await withReactRoot(tree(), async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(labels()).toEqual(expect.arrayContaining(["rp-a", "fresh"]));

      await act(async () =>
        live.set("doc-a", { uri: "manuscript:///rp-a-renamed.md", path: "/rp-a-renamed.md" }),
      );
      // The list was never refetched; the label still tracks the document.
      expect(api.listWorkDrafts).toHaveBeenCalledTimes(1);
      expect(labels()).toEqual(expect.arrayContaining(["rp-a-renamed", "fresh"]));
      expect(labels()).not.toContain("rp-a");
    });
  });
});
