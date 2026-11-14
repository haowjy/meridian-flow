// @vitest-environment jsdom
/**
 * Which presentations keep a document draft-only, and what ends them: a late answer about an old
 * host mount, the document coming back live, the held draft ending. Real registry, removal
 * coordinator; the presented document, the removed notice and the server answers (draft lists,
 * draft metadata, catalog) are stubs.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - one registry token per host mount, and one per draft held open by a live delete
 * - settlement closes a document only on its own presentation's `gone` answer
 * - the coordinator's committed `available` command promotes the document
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenDocument } from "@/client/stores";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftOnlySettlement } from "./DraftOnlySettlement";
import { DraftOnlyPresentations } from "./draft-only-presentations";

const projectId = "project-a";
const documentId = "00000000-0000-4000-8000-000000000001";
const ownerKey = "work:work-a";
const itemKey = `branch-a:${documentId}`;
const contextLocation = { scheme: "manuscript" as const, path: "/Chapter.md" };
const draft = { projectId, documentId, ownerKey, itemKey, contextLocation };

let registry: DraftOnlyPresentations;
let removal: ContextRemovalCoordinator;
const metadataAnswers: Array<(answer: { status: "gone" | "active" }) => void> = [];
/** What the removed notice was told the writer lost. */
let removedNotices: string[] = [];
const presentedTab: OpenDocument = {
  kind: "tracked",
  documentId,
  ...contextLocation,
  name: "Chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => "account-a",
  useOptionalDraftOnlyPresentations: () => registry,
  useOptionalContextRemovalCoordinator: () => removal,
  useOptionalAccountResourceReplica: () => ({
    acquireCatalogAfter: async () => ({ entries: new Map() }),
  }),
  useObservedResourceProjection: () => ({ records: [], placement: null }),
  useOptionalProjectContextAvailabilityCoordinator: () => null,
  useOptionalRemovedNotices: () => ({
    presentedRemoved: (_project: string, tabs: readonly OpenDocument[]) =>
      removedNotices.push(...tabs.map((tab) => tab.documentId)),
  }),
}));
vi.mock("@/client/query/useOwnerDrafts", () => ({
  useOwnerDrafts: () => ({ status: "ready", drafts: [] }),
  cachedOwnerDrafts: () => [],
  catalogOwnerOf: () => ({}),
  ownerDraftsQueryOptions: (project: string, owner: string) => ({
    queryKey: ["owner-drafts", project, owner],
    queryFn: async () => ({ items: [] }),
  }),
}));
vi.mock("@/client/query/useDraftMetadata", () => ({
  fetchCurrentDraftMetadata: () =>
    new Promise((resolve) => {
      metadataAnswers.push(resolve);
    }),
}));
vi.mock("@/features/project/use-work-scope", () => ({
  useScopeDraftOwner: () => ({ picked: null, work: null, ownerKey: "" }),
}));

beforeEach(() => {
  registry = new DraftOnlyPresentations();
  removedNotices = [];
  removal = new ContextRemovalCoordinator("account-a", {
    presented: {
      documents: () => [presentedTab],
      mainDocumentId: () => documentId,
      forget: () => {},
    },
    draftOnly: registry,
    drafts: { boundDrafts: () => [{ ownerKey, itemKey }] },
  });
  metadataAnswers.length = 0;
});

async function settling(run: () => Promise<void>) {
  await withReactRoot(
    <QueryClientProvider client={new QueryClient()}>
      <DraftOnlySettlement projectId={projectId} />
    </QueryClientProvider>,
    run,
    { drainMacrotask: true },
  );
}

it("a late gone answer about an old mount leaves a newer mount of the same item open", async () => {
  await settling(async () => {
    act(() => registry.present({ ...draft, token: "mount-1" }));
    await vi.waitFor(() => expect(metadataAnswers).toHaveLength(1));
    act(() => {
      registry.withdraw("mount-1");
      registry.present({ ...draft, token: "mount-2" });
    });
    await vi.waitFor(() => expect(metadataAnswers).toHaveLength(2));
    await act(async () => metadataAnswers[0]?.({ status: "gone" }));
    expect(registry.state("mount-2")).toBe("draft-only");
    expect(removedNotices).toEqual([]);
  });
});

function command(kind: "gone" | "back") {
  return { kind, projectId, documentId } as const;
}

it("a live delete's hold ends when live has the document again", async () => {
  removal.applyRemovals([command("gone")]);
  expect(registry.isDraftOnly(projectId, documentId)).toBe(true);
  expect(removedNotices).toEqual([]);

  removal.applyRemovals([command("back")]);
  expect(registry.isDraftOnly(projectId, documentId)).toBe(false);
});

it("a live delete's hold ends with its draft, and the document is said removed", async () => {
  removal.applyRemovals([command("gone")]);
  await settling(async () => {
    await vi.waitFor(() => expect(metadataAnswers).toHaveLength(1));
    await act(async () => metadataAnswers[0]?.({ status: "gone" }));
    await vi.waitFor(() => expect(removedNotices).toEqual([documentId]));
    expect(registry.isDraftOnly(projectId, documentId)).toBe(false);
  });
});
