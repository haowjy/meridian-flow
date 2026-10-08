// @vitest-environment jsdom
/** Draft dispositions: draft-only Discard closes its tab at once, and Apply is done at server confirmation. */
import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeCommandState,
  currentChangeCommandRecords,
} from "@/client/query/change-command-record";
import {
  confirmDraftCommand,
  draftCommandFailure,
  resetDraftCommandRecords,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { DraftCommandOutcomeUnknownError } from "@/client/query/useDraftReviewMutations";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { contextTabFromFile } from "@/features/project/context/context-tab-from-file";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import type { ProjectSearch } from "@/features/project/routing/project-route";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftReviewBoundary, type DraftReviewContextValue } from "./DraftReviewProvider";
import { type ChangeCommandRunner, useChangeCommandRunner } from "./useChangeCommandRunner";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

/** Only the identity and archive state of a Work reach the controller. */
const workFixture = (id: string): Work =>
  ({ id, projectId: "project-a", name: id, isNoWork: false, archivedAt: null }) as Work;

let resolveDiscard: (() => void) | null = null;
let rejectDiscard: ((reason: unknown) => void) | null = null;
let currentAddress = "";
let coordinator: ContextRemovalCoordinator;
let addressWrites = 0;
let search: ProjectSearch;

vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: vi.fn(async () => ({
    status: "active",
    draftId: "draft-a",
    reviewRoomName: "review-room-a",
  })),
}));

const applyMutate = vi.hoisted(() => vi.fn());
const applyChangesMutate = vi.hoisted(() => vi.fn());

vi.mock("@/client/query/useDraftReviewMutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/query/useDraftReviewMutations")>()),
  useApplyDraft: () => ({ mutateAsync: applyMutate }),
  useApplyDraftChanges: () => ({ mutateAsync: applyChangesMutate }),
  useDiscardDraft: () => ({
    mutateAsync: () =>
      new Promise<void>((resolve, reject) => {
        resolveDiscard = resolve;
        rejectDiscard = reject;
      }),
  }),
}));

vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => coordinator,
}));

const draftTab = contextTabFromDraftGroup({
  workId: "work-a",
  documentId: "document-a",
  draftId: "draft-a",
  contextPath: "/chapter.md",
  isNewDocument: true,
});
if (!draftTab) throw new Error("Draft tab fixture must be editable");

const addressedTab = contextTabFromFile(
  "manuscript",
  {
    kind: "file",
    entryId: "entry-a",
    parentId: "manuscript-root",
    documentId: "document-a",
    name: "chapter.md",
    path: "/chapter.md",
    uri: "manuscript://@work-a/chapter.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    resourceHandle: "resource-a",
    resourceState: "acknowledged",
  },
  "work-a",
);

const neighborTab = contextTabFromFile(
  "manuscript",
  {
    kind: "file",
    entryId: "entry-b",
    parentId: "manuscript-root",
    documentId: "document-b",
    name: "live-neighbor.md",
    path: "/live-neighbor.md",
    uri: "manuscript://@work-a/live-neighbor.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  },
  "work-a",
);

let controller: DraftReviewController | null = null;
let heldRecords: ReturnType<typeof useDraftCommandRecords> = {};

function heldError() {
  return draftCommandFailure(heldRecords, {
    projectId: "project-a",
    workId: "work-a",
    documentId: "document-a",
    draftId: "draft-a",
  });
}

let otherSurface: DraftReviewController | null = null;

/** A second review scope over the same Work, like the Editor beside Chat. */
function CaptureOtherSurface() {
  otherSurface = useDraftReviewController({ projectId: "project-a", work: workFixture("work-a") });
  return null;
}

let unrelated: DraftReviewController[] = [];

/** Other Works and projects, which share nothing with the draft under command. */
function CaptureUnrelated() {
  unrelated = [
    useDraftReviewController({ projectId: "project-a", work: workFixture("work-b") }),
    useDraftReviewController({ projectId: "project-b", work: workFixture("work-a") }),
  ];
  return null;
}

let switching: DraftReviewController | null = null;
let switchWork!: (workId: string) => void;

/** One controller that moves between Works, like the Editor's across navigation. */
function CaptureSwitching() {
  const [workId, setWorkId] = useState("work-a");
  switchWork = setWorkId;
  switching = useDraftReviewController({ projectId: "project-a", work: workFixture(workId) });
  return null;
}

function CaptureController() {
  controller = useDraftReviewController({ projectId: "project-a", work: workFixture("work-a") });
  heldRecords = useDraftCommandRecords();
  return null;
}

function Providers({
  children,
  open,
  isCurrent,
  client,
}: {
  children: ReactNode;
  open: OpenContextRoute;
  isCurrent?: () => boolean;
  client?: QueryClient;
}) {
  const queryClient = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectNavigationProvider
        openContextRoute={open}
        isCurrentContextRoute={isCurrent}
        screen="context"
      >
        {children}
      </ProjectNavigationProvider>
    </QueryClientProvider>
  );
}

describe("draft dispositions", () => {
  beforeEach(() => {
    // The real mutation turns its claim into the confirmed record.
    applyMutate.mockReset().mockImplementation(async (draft) => confirmDraftCommand(draft));
    controller = null;
    rejectDiscard = null;
    resolveDiscard = null;
    currentAddress = "/projects/project-a/@work-a/manuscript/chapter.md";
    addressWrites = 0;
    resetDraftCommandRecords();
    search = {
      screen: "context",
      work: "work-a",
      scheme: "manuscript",
      path: "/chapter.md",
    };
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _workspaceHydrated: false,
    });
    expect(draftTab).toMatchObject({
      scheme: "manuscript",
      documentId: "document-a",
      draftOnly: true,
      reviewWorkId: "work-a",
    });
    expect(draftTab).not.toHaveProperty("workId");
    useContextTabsStore.getState().openTab("project-a", draftTab);
    // The readable address owner resolves the same server document after the
    // review launcher installs its transient tab. It must not create a hidden
    // durable member underneath the review overlay.
    useContextTabsStore.getState().openTab("project-a", addressedTab);
    expect(getContextTabs("project-a").tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: "document-a",
          draftOnly: true,
          resourceHandle: "resource-a",
        }),
      ]),
    );
    useContextTabsStore.getState().openTab("project-a", neighborTab);
    void useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
        addressWrites += 1;
        currentAddress = search.path
          ? `/projects/project-a/@work-a/manuscript/${search.path.replace(/^\/+/, "")}`
          : "/projects/project-a/@work-a/editor";
      },
      transition: async () => ({ kind: "applied" as const }),
    };
    coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");
    const revision = coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/chapter.md",
      workId: "work-a",
    });
    coordinator.bindRouteSelection("project-a", revision, {
      kind: "server",
      documentId: "document-a",
    });
  });

  it("keeps the tab closed and holds the error on the draft when Discard is refused", async () => {
    const open = vi.fn<OpenContextRoute>();
    await withReactRoot(
      <Providers open={open}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => controller?.enterInlineReview("document-a", "draft-a"));
        let disposition: Promise<unknown> | undefined;
        await act(async () => {
          disposition = controller?.discard("document-a", "draft-a");
        });

        // The tab closes with the click and the neighbour takes over.
        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);
        expect(currentAddress).toBe("/projects/project-a/@work-a/manuscript/live-neighbor.md");
        expect(addressWrites).toBe(1);

        await act(async () => {
          rejectDiscard?.(new Error("offline"));
          await disposition;
        });

        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);
        expect(addressWrites).toBe(1);
        expect(open).not.toHaveBeenCalled();
        expect(heldError()).toEqual({ code: "discard-offline" });

        // Retrying clears the held error, and a confirmed Discard leaves none.
        let retry: Promise<unknown> | undefined;
        await act(async () => {
          retry = controller?.discard("document-a", "draft-a");
        });
        expect(heldError()).toBeNull();
        await act(async () => {
          resolveDiscard?.();
          await retry;
        });
        expect(heldError()).toBeNull();
        expect(open).not.toHaveBeenCalled();
        expect(addressWrites).toBe(1);
        expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-b" }]);
      },
    );
  });

  it("gives the claim back when Discard's optimistic close throws before dispatch", async () => {
    vi.spyOn(coordinator, "discardDraft").mockImplementationOnce(() => {
      throw new Error("route repair failed");
    });
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>()}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => {
          await expect(controller?.discard("document-a", "draft-a")).rejects.toThrow(
            "route repair failed",
          );
        });
        expect(resolveDiscard).toBeNull();
        expect(controller?.isDisposing).toBe(false);
        let outcome: unknown;
        await act(async () => {
          outcome = await controller?.apply("document-a", "draft-a");
        });
        expect(outcome).toEqual({ kind: "applied" });
      },
    );
  });

  it("leaves a pending Apply behind when the controller moves to another Work", async () => {
    applyMutate.mockImplementation(() => new Promise<void>(() => undefined));
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>()}>
        <CaptureSwitching />
      </Providers>,
      async () => {
        await act(async () => {
          void switching?.apply("document-a", "draft-a");
        });
        expect(switching?.isDisposing).toBe(true);
        await act(async () => switchWork("work-b"));
        expect(switching?.isDisposing).toBe(false);
        await act(async () => switchWork("work-a"));
        expect(switching?.isDisposing).toBe(true);
      },
    );
  });

  it("counts Apply as done at server confirmation: promotes the draft-only tab and leaves review", async () => {
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>()}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => controller?.enterInlineReview("document-a", "draft-a"));
        let outcome: unknown;
        await act(async () => {
          outcome = await controller?.apply("document-a", "draft-a");
        });

        expect(outcome).toEqual({ kind: "applied" });
        expect(controller?.inlineReview).toBeNull();
        expect(useContextTabsStore.getState()._reviewOverlayByProject["project-a"]?.tabs).toEqual(
          [],
        );
        const live = useContextTabsStore
          .getState()
          .byProject["project-a"]?.tabs.find((tab) => tab.documentId === "document-a");
        expect(live).toBeDefined();
        expect(live).not.toHaveProperty("draftOnly");
        expect(heldError()).toBeNull();
      },
    );
  });

  it("holds a lost Apply response as unknown on the draft, apart from a rejection", async () => {
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>()}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => controller?.enterInlineReview("document-a", "draft-a"));
        applyMutate.mockRejectedValueOnce(new DraftCommandOutcomeUnknownError());
        let outcome: unknown;
        await act(async () => {
          outcome = await controller?.apply("document-a", "draft-a");
        });
        expect(outcome).toEqual({ kind: "apply-outcome-unknown" });
        expect(heldError()).toEqual({ code: "apply-unknown" });
        expect(controller?.inlineReview).toMatchObject({ draftId: "draft-a" });
        expect(
          getContextTabs("project-a").tabs.some((tab) => "draftOnly" in tab && tab.draftOnly),
        ).toBe(true);

        applyMutate.mockRejectedValueOnce(new Error("rejected"));
        await act(async () => {
          outcome = await controller?.apply("document-a", "draft-a");
        });
        expect(outcome).toEqual({ kind: "failed", failure: { code: "apply-offline" } });
        // A rejection is held on the draft too, apart from the unknown outcome.
        expect(heldError()).toEqual({ code: "apply-offline" });
      },
    );
  });

  it("dispatches one Apply when the Editor and Chat both press it, and disables both", async () => {
    let confirm!: () => void;
    applyMutate.mockImplementation(
      (draft) =>
        new Promise<void>((resolve) => {
          confirm = () => resolve(confirmDraftCommand(draft));
        }),
    );
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>()}>
        <CaptureController />
        <CaptureOtherSurface />
        <CaptureUnrelated />
      </Providers>,
      async () => {
        let first: Promise<unknown> | undefined;
        await act(async () => {
          first = controller?.apply("document-a", "draft-a");
        });
        let second: unknown;
        await act(async () => {
          second = await otherSurface?.disposeDrafts("apply", [
            { documentId: "document-a", draftId: "draft-a" },
          ]);
        });
        expect(second).toEqual([{ kind: "blocked" }]);
        expect(applyMutate).toHaveBeenCalledTimes(1);
        expect(controller?.isDisposing).toBe(true);
        expect(otherSurface?.isDisposing).toBe(true);
        expect(unrelated.map((surface) => surface.isDisposing)).toEqual([false, false]);

        await act(async () => {
          confirm();
          await first;
        });
        expect(otherSurface?.isDisposing).toBe(false);
      },
    );
  });

  it("advances a bulk Apply at server confirmation while navigation is still pending", async () => {
    const navigation = new Promise<never>(() => undefined);
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>(() => navigation)} isCurrent={() => true}>
        <CaptureController />
      </Providers>,
      async () => {
        let outcomes: unknown;
        await act(async () => {
          outcomes = await controller?.disposeDrafts("apply", [
            { documentId: "document-a", draftId: "draft-a" },
            { documentId: "document-b", draftId: "draft-b" },
          ]);
        });
        expect(outcomes).toEqual([{ kind: "applied" }, { kind: "applied" }]);
        expect(applyMutate).toHaveBeenCalledTimes(2);
        expect(controller?.isDisposing).toBe(false);
      },
    );
  });
});

let runner: ChangeCommandRunner | null = null;

function RunnerHost({ caller }: { caller: DraftReviewController }) {
  runner = useChangeCommandRunner(caller);
  return null;
}

/** A caller scope and a separate Editor scope over one Work, with the runner the caller's surfaces use. */
function CaptureRunner() {
  const caller = useDraftReviewController({ projectId: "project-a", work: workFixture("work-a") });
  const editor = useDraftReviewController({ projectId: "project-a", work: workFixture("work-a") });
  return (
    <DraftReviewBoundary value={{ controller: editor } as DraftReviewContextValue}>
      <RunnerHost caller={caller} />
    </DraftReviewBoundary>
  );
}

describe("a batch of change selections", () => {
  const files = ["a", "b", "c"].map((id) => ({
    draft: { documentId: `document-${id}`, draftId: `draft-${id}` },
    selection: { classIds: [`class-${id}1`, `class-${id}2`], operationIds: [`${id}1`, `${id}2`] },
  }));
  const ref = (id: string) => ({
    projectId: "project-a",
    workId: "work-a",
    documentId: `document-${id}`,
    draftId: `draft-${id}`,
  });
  const operation = (id: string, classId: string) => ({
    operationId: id,
    closureClassId: classId,
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
  });
  const answered = { status: "applied", draftClosed: false };
  let client: QueryClient;

  async function runBatch() {
    let outcomes: Awaited<ReturnType<ChangeCommandRunner["applyBatch"]>> = [];
    await withReactRoot(
      <Providers open={vi.fn<OpenContextRoute>()} client={client}>
        <CaptureRunner />
      </Providers>,
      async () => {
        await act(async () => {
          outcomes = (await runner?.applyBatch(files)) ?? [];
        });
      },
    );
    return outcomes;
  }

  beforeEach(() => {
    resetDraftCommandRecords();
    applyChangesMutate.mockReset().mockResolvedValue(answered);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const { draft } of files) {
      const id = draft.draftId.slice(-1);
      client.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", draft.documentId, draft.draftId),
        {
          status: "active",
          draftId: draft.draftId,
          inlineModelPresent: true,
          reviewRoomName: `room-${id}`,
          liveRevisionToken: `live-${id}`,
          draftRevisionToken: `draft-${id}`,
          operations: [operation(`${id}1`, `class-${id}1`), operation(`${id}2`, `class-${id}2`)],
          hunks: [],
        },
      );
    }
  });

  it("sends one command per file with the union of its operations and that file's tokens", async () => {
    const outcomes = await runBatch();
    expect(outcomes.map(({ outcome }) => outcome.kind)).toEqual([
      "change-settled",
      "change-settled",
      "change-settled",
    ]);
    expect(applyChangesMutate.mock.calls.map(([call]) => [call.draftId, call.request])).toEqual(
      ["a", "b", "c"].map((id) => [
        `draft-${id}`,
        {
          operationIds: [`${id}1`, `${id}2`],
          liveRevisionToken: `live-${id}`,
          draftRevisionToken: `draft-${id}`,
        },
      ]),
    );
  });

  it("gives every file its turn when one is refused, and holds each outcome on its own file", async () => {
    applyChangesMutate
      .mockResolvedValueOnce({ status: "stale", draftId: "draft-a" })
      .mockRejectedValueOnce(new DraftCommandOutcomeUnknownError())
      .mockResolvedValueOnce(answered);
    const outcomes = await runBatch();

    expect(applyChangesMutate).toHaveBeenCalledTimes(3);
    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      { kind: "change-refused", mode: "apply", code: "stale" },
      { kind: "change-refused", mode: "apply", code: "unknown" },
      { kind: "change-settled", mode: "apply" },
    ]);
    const held = (id: string) =>
      changeCommandState(
        currentChangeCommandRecords(),
        ref(id),
        files["abc".indexOf(id)].selection,
      );
    expect(held("a")).toMatchObject({ phase: "failed", code: "stale" });
    expect(held("b")).toMatchObject({ phase: "failed", code: "unknown" });
    expect(held("c")).toBeNull();
    // A file's failure does not show on another file's changes.
    expect(
      changeCommandState(currentChangeCommandRecords(), ref("a"), files[1].selection),
    ).toBeNull();
  });

  it("keeps going after a rejection, and refuses a file with no preview without sending it", async () => {
    client.removeQueries({
      queryKey: projectQueryKeys.workDraftPreview("project-a", "work-a", "document-b", "draft-b"),
    });
    applyChangesMutate.mockRejectedValueOnce(new Error("offline"));
    const outcomes = await runBatch();

    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      { kind: "change-refused", mode: "apply", code: "offline" },
      { kind: "change-refused", mode: "apply", code: "stale" },
      { kind: "change-settled", mode: "apply" },
    ]);
    expect(applyChangesMutate.mock.calls.map(([call]) => call.draftId)).toEqual([
      "draft-a",
      "draft-c",
    ]);
  });
});
