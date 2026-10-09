// @vitest-environment jsdom
/**
 * The Work page's Changes to review: files in the one file order that expand in
 * place to their changes, per-change commands that never open a review, a chat
 * link that opens the chat beside, and Apply all and Discard all across every
 * draft of the Work. Real provider, controllers, mutations and query cache; the
 * network is the only fake. The scope-resolution rule is checked with plain
 * scopes, because which controller ran a batch is all it decides.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { act, type ReactNode, useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { ThreadStoreProvider } from "@/client/stores";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  EditorReviewScope,
} from "@/features/draft-review/DraftReviewProvider";
import {
  abandonConversationReveal,
  peekConversationReveal,
} from "@/test-support/conversation-reveal";
import {
  applied,
  listed,
  operation,
  preview,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useProjectChatNavigation } from "../routing/chat-navigation";
import { WorkReviewScopesProvider } from "./useWorkReviewScope";
import { WorkChanges } from "./WorkChanges";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraft: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
  openAiDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));
vi.mock("../dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: mocks.openAiDraft }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useOptionalAccountEpochSignal: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const WORK = "work-a" as ParsedRequestId;

/** A listed draft of document `key`, named `name`. */
const draftOf = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  ...listed,
  documentId: `document-${key}`,
  draftId: `draft-${key}`,
  documentName: name,
  contextPath: `/${name}.md`,
  ...extra,
});

/** What the server holds now for each draft's preview. */
const previews: Record<string, unknown> = {};
function serverHolds(key: string, ...ids: string[]) {
  previews[`draft-${key}`] = {
    ...preview,
    draftId: `draft-${key}`,
    operations: ids.map((id) => operation(id)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  abandonConversationReveal();
  for (const key of Object.keys(previews)) delete previews[key];
  mocks.getDraftPreview.mockImplementation(
    async (_project: string, _work: string, _document: string, draftId: string) =>
      previews[draftId],
  );
  mocks.applyDraft.mockResolvedValue({ status: "applied" });
  mocks.discardDraft.mockResolvedValue({ status: "discarded" });
});

function surface(
  node: ReactNode,
  { onOpenThread = vi.fn() }: { onOpenThread?: (threadId: string) => void } = {},
) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return (
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <ChatThreadNavigationProvider onOpenThread={onOpenThread}>
          {node}
        </ChatThreadNavigationProvider>
      </TooltipProvider>
    </I18nProvider>
  );
}

const changes = (props: Partial<React.ComponentProps<typeof WorkChanges>> = {}) =>
  surface(
    <WorkChanges projectId="project-a" workId={WORK} matchesSearch={() => true} {...props} />,
  );

const toggles = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label^='Changes in ']"));
const toggle = (name: string) => {
  const found = toggles().find(
    (button) => button.getAttribute("aria-label") === `Changes in ${name}`,
  );
  if (!found) throw new Error(`No file named ${name}`);
  return found;
};
const nameButton = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) =>
      button.textContent?.trim().startsWith(name) && !button.hasAttribute("aria-expanded"),
  );
const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-review-change-row]")).map(
    (row) => row.dataset.reviewChangeRow,
  );
const button = (label: string, within: ParentNode = document) =>
  within.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const textButton = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === text,
  );
const rowOf = (classId: string) =>
  document.querySelector<HTMLElement>(`[data-review-change-row="${classId}"]`) as HTMLElement;

async function openMenu() {
  await act(async () => {
    button("All drafts")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}
const menuItem = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find(
    (item) => item.textContent?.trim() === name,
  );

async function listed3(probe: () => ScopeProbe, count: number) {
  await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(count));
}

describe("WorkChanges", () => {
  it("lists the Work's drafts in the one file order, not the order the server sent", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftOf("z", "Zeta"), draftOf("a", "alpha"), draftOf("b", "Beta")],
    });
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 3);
        expect(toggles().map((node) => node.getAttribute("aria-label"))).toEqual([
          "Changes in alpha",
          "Changes in Beta",
          "Changes in Zeta",
        ]);
        expect(document.body.textContent).toContain("Changes to review");
      },
      { surface: changes() },
    );
  });

  it("reads a file's preview only when it is expanded, and reads it once", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftOf("b", "Chapter 13"), draftOf("c", "Chapter 14")],
    });
    serverHolds("b", "7", "8");
    serverHolds("c", "9");
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 2);
        expect(mocks.getDraftPreview).not.toHaveBeenCalled();

        await act(async () => toggle("Chapter 13").click());
        await vi.waitFor(() => expect(rows()).toEqual(["class-7", "class-8"]));
        expect(mocks.getDraftPreview.mock.calls.map((call) => call[3])).toEqual(["draft-b"]);
        expect(toggle("Chapter 13").getAttribute("aria-expanded")).toBe("true");

        // Collapsing and expanding again does not read it again.
        await act(async () => toggle("Chapter 13").click());
        expect(rows()).toEqual([]);
        await act(async () => toggle("Chapter 13").click());
        expect(mocks.getDraftPreview).toHaveBeenCalledTimes(1);
      },
      { surface: changes() },
    );
  });

  it("shows a skeleton while the preview loads, and Retry when it cannot be read", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("b", "Chapter 13")] });
    let settle!: (value: unknown) => void;
    mocks.getDraftPreview.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => toggle("Chapter 13").click());
        expect(document.querySelector("[aria-busy]")).not.toBeNull();
        expect(document.body.textContent).not.toContain("0 changes");

        await act(async () => settle(Promise.reject(new Error("unreachable"))));
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("Changes couldn’t load"),
        );
        serverHolds("b", "7");
        mocks.getDraftPreview.mockImplementation(async () => previews["draft-b"]);
        await act(async () => textButton("Retry changes")?.click());
        await vi.waitFor(() => expect(rows()).toEqual(["class-7"]));
      },
      { surface: changes() },
    );
  });

  it("applies one change of an unopened draft without opening it", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("b", "Chapter 13")] });
    serverHolds("b", "7", "8");
    mocks.applyDraftChanges.mockResolvedValue({
      ...applied(false, "7"),
      draftId: "draft-b",
      closureClassIds: ["class-7"],
    });
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => toggle("Chapter 13").click());
        await vi.waitFor(() => expect(rows()).toEqual(["class-7", "class-8"]));

        await act(async () => button("Apply", rowOf("class-7"))?.click());
        expect(mocks.applyDraftChanges).toHaveBeenCalledWith(
          "project-a",
          "work-a",
          "document-b",
          expect.objectContaining({ draftId: "draft-b", operationIds: ["7"] }),
        );
        expect(rows()).toEqual(["class-8"]);
        // Applying is not reviewing: nothing was opened.
        expect(mocks.openAiDraft).not.toHaveBeenCalled();
        expect(probe().editor.controller.inlineReview).toBeNull();
      },
      { surface: changes() },
    );
  });

  it("expands a new document to a line that sends the writer to its review", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftOf("n", "Interlude", { isNewDocument: true })],
    });
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => toggle("Interlude").click());
        expect(document.body.textContent).toContain("New document. Review it to apply.");
        expect(document.body.textContent).toContain("New");
        expect(rows()).toEqual([]);
        expect(button("Apply")).toBeNull();
        expect(mocks.getDraftPreview).not.toHaveBeenCalled();
      },
      { surface: changes() },
    );
  });

  it("says formatting remains for a draft that lists no change, not that it has no changes", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("f", "Notes")] });
    serverHolds("f");
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => toggle("Notes").click());
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("Formatting changes remain"),
        );
        expect(rows()).toEqual([]);
      },
      { surface: changes() },
    );
  });

  it("opens the file's review at the top from its name, and focused on a change from the change's row", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("b", "Chapter 13")] });
    serverHolds("b", "7", "8");
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => nameButton("Chapter 13")?.click());
        expect(mocks.openAiDraft).toHaveBeenLastCalledWith({
          workId: "work-a",
          documentId: "document-b",
          draftId: "draft-b",
          contextPath: "/Chapter 13.md",
          documentName: "Chapter 13",
          isNewDocument: false,
        });

        await act(async () => toggle("Chapter 13").click());
        await vi.waitFor(() => expect(rows()).toEqual(["class-7", "class-8"]));
        await act(async () => rowOf("class-8").querySelector("button")?.click());
        expect(mocks.openAiDraft).toHaveBeenLastCalledWith(
          expect.objectContaining({
            documentId: "document-b",
            draftId: "draft-b",
            focusOperationIds: ["8"],
          }),
        );
      },
      { surface: changes() },
    );
  });

  it("opens the chat beside, at the turn, from a change's chat link, and keeps the screen", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("b", "Chapter 13")] });
    previews["draft-b"] = {
      ...preview,
      draftId: "draft-b",
      operations: [
        {
          ...operation("7"),
          actorThreadId: "thread-pacing",
          actorThreadTitle: "Pacing pass",
          actorTurnId: "turn-9",
          actorToolCallId: "call-3",
        },
      ],
    };
    const go = vi.fn(async () => undefined);
    const revealDock = vi.fn();
    function ChatBeside({ children }: { children: ReactNode }) {
      const navigation = useProjectChatNavigation({
        accountId: "writer",
        projectId: "project-a",
        activeScreen: "work",
        urlChatId: null,
        go,
      });
      useLayoutEffect(
        () => navigation.registerDockReveal(revealDock),
        [navigation.registerDockReveal],
      );
      return (
        <ChatThreadNavigationProvider onOpenThread={(id) => void navigation.openChat(id)}>
          {children}
        </ChatThreadNavigationProvider>
      );
    }
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => toggle("Chapter 13").click());
        await vi.waitFor(() => expect(rows()).toEqual(["class-7"]));
        await act(async () =>
          rowOf("class-7")
            .querySelector<HTMLButtonElement>(
              "button[title='Open the chat that wrote this change']",
            )
            ?.click(),
        );
        // The dock shows the chat at the write; the writer's screen did not move,
        // and the row's own click did not also open the review.
        expect(peekConversationReveal()).toEqual({
          kind: "turn",
          threadId: "thread-pacing",
          turnId: "turn-9",
          toolCallId: "call-3",
        });
        await vi.waitFor(() => expect(revealDock).toHaveBeenCalledWith("chat"));
        expect(go).not.toHaveBeenCalled();
        expect(mocks.openAiDraft).not.toHaveBeenCalled();
      },
      {
        surface: surface(
          <ThreadStoreProvider now={0}>
            <ChatBeside>
              <WorkChanges projectId="project-a" workId={WORK} matchesSearch={() => true} />
            </ChatBeside>
          </ThreadStoreProvider>,
        ),
      },
    );
  });

  it("holds a refused whole-draft command on the file's row until it is dismissed", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("b", "Chapter 13")] });
    mocks.applyDraft.mockRejectedValue(new Error("offline"));
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 1);
        await act(async () => {
          await probe().editor.controller.disposeDrafts("apply", [
            { documentId: "document-b", draftId: "draft-b" },
          ]);
        });
        await vi.waitFor(() => expect(document.querySelector("[role=alert]")).not.toBeNull());
        await act(async () =>
          button("Dismiss", document.querySelector("[role=alert]") as ParentNode)?.click(),
        );
        expect(document.querySelector("[role=alert]")).toBeNull();
      },
      { surface: changes() },
    );
  });
});

describe("Apply all and Discard all", () => {
  const everyKind = () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftOf("a", "Chapter 12"),
        draftOf("b", "Chapter 13"),
        draftOf("n", "Interlude", { isNewDocument: true }),
        draftOf("f", "Notes"),
      ],
    });
    serverHolds("a", "1", "2");
    serverHolds("b", "7");
    serverHolds("f");
  };
  const documentsSent = (mock: typeof mocks.applyDraft) =>
    mock.mock.calls.map((call) => call[2]).sort();
  const all = ["document-a", "document-b", "document-f", "document-n"];

  it("covers every draft of the Work whatever the search box filters, and says how many", async () => {
    everyKind();
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 4);
        await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
        await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
        // Only the unopened Chapter 13 matches; the menu still counts the Work's four.
        expect(toggles().map((node) => node.getAttribute("aria-label"))).toEqual([
          "Changes in Chapter 13",
        ]);
        await openMenu();
        expect(menuItem("Apply all 4 drafts")).toBeDefined();
        await act(async () => menuItem("Apply all 4 drafts")?.click());

        // Unopened, new, formatting-only and the Editor's open review, all in one batch.
        await vi.waitFor(() => expect(documentsSent(mocks.applyDraft)).toEqual(all));
        await vi.waitFor(() =>
          expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
            phase: "closed",
          }),
        );
      },
      { surface: changes({ matchesSearch: (name) => name.includes("13") }) },
    );
  });

  it("asks before Discard all, in the menu's place, and then discards every draft", async () => {
    everyKind();
    await renderReviewScopes(
      async (probe) => {
        await listed3(probe, 4);
        await openMenu();
        await act(async () => menuItem("Discard all 4 drafts")?.click());
        expect(document.body.textContent).toContain("Discard all 4 drafts?");
        expect(button("All drafts")).toBeNull();
        expect(mocks.discardDraft).not.toHaveBeenCalled();

        // Keep backs out and sends nothing.
        await act(async () => textButton("Keep")?.click());
        expect(button("All drafts")).not.toBeNull();
        expect(mocks.discardDraft).not.toHaveBeenCalled();

        await openMenu();
        await act(async () => menuItem("Discard all 4 drafts")?.click());
        await act(async () => textButton("Discard")?.click());
        await vi.waitFor(() => expect(documentsSent(mocks.discardDraft)).toEqual(all));
      },
      { surface: changes() },
    );
  });
});

describe("the scope that runs a Work page's batch", () => {
  const scopeFor = (workId: string) =>
    ({
      controller: {
        projectId: "project-a",
        workId,
        dispositionLocked: false,
        disposeDrafts: vi.fn(async () => []),
      },
      groups: [
        {
          documentId: "document-1",
          documentName: "Chapter 1",
          contextPath: "/Chapter 1.md",
          draft: { draftId: "draft-1", documentId: "document-1", status: "active" },
        },
      ],
      drafts: { status: "ready", refetch: vi.fn() },
    }) as unknown as DraftReviewContextValue;

  /** The Editor's, the chat's and the third scope, over the given Works. */
  async function onWorkPage(
    works: { editor: string; chat: string; third: string },
    pageWork: string,
    run: (scopes: Record<"editor" | "chat" | "third", DraftReviewContextValue>) => Promise<void>,
  ) {
    const scopes = {
      editor: scopeFor(works.editor),
      chat: scopeFor(works.chat),
      third: scopeFor(works.third),
    };
    await withReactRoot(
      surface(
        <DraftReviewBoundary value={scopes.chat}>
          <EditorReviewScope value={scopes.editor}>
            <WorkReviewScopesProvider chat={scopes.chat} third={scopes.third}>
              <WorkChanges
                projectId="project-a"
                workId={pageWork as ParsedRequestId}
                matchesSearch={() => true}
              />
            </WorkReviewScopesProvider>
          </EditorReviewScope>
        </DraftReviewBoundary>,
      ),
      () => run(scopes),
    );
  }
  const applyAll = async () => {
    await openMenu();
    await act(async () => menuItem("Apply all 1 draft")?.click());
  };
  const ran = (scopes: Record<string, DraftReviewContextValue>) =>
    Object.entries(scopes)
      .filter(([, scope]) => vi.mocked(scope.controller.disposeDrafts).mock.calls.length > 0)
      .map(([name]) => name);
  const works = { editor: "work-e", chat: "work-c", third: "work-t" };

  it("is the Editor's when the Work page's Work is the Editor's", async () => {
    await onWorkPage(works, "work-e", async (scopes) => {
      await applyAll();
      expect(ran(scopes)).toEqual(["editor"]);
      expect(scopes.editor.controller.disposeDrafts).toHaveBeenCalledWith("apply", [
        { documentId: "document-1", draftId: "draft-1" },
      ]);
    });
  });

  it("is the chat's when only the chat has the Work", async () => {
    await onWorkPage(works, "work-c", async (scopes) => {
      await applyAll();
      expect(ran(scopes)).toEqual(["chat"]);
    });
  });

  it("is the third scope for a Work neither has", async () => {
    await onWorkPage(works, "work-t", async (scopes) => {
      await applyAll();
      expect(ran(scopes)).toEqual(["third"]);
    });
  });

  it("is the Editor's when all three are the same Work", async () => {
    await onWorkPage({ editor: "w", chat: "w", third: "w" }, "w", async (scopes) => {
      await applyAll();
      expect(ran(scopes)).toEqual(["editor"]);
    });
  });

  it("shows nothing while no scope covers the Work yet", async () => {
    await onWorkPage(works, "work-resolving", async () => {
      expect(document.body.textContent).not.toContain("Changes to review");
    });
  });

  it("disables Apply all and Discard all once the Work is archived", async () => {
    const scopes = {
      editor: scopeFor("work-e"),
      chat: scopeFor("work-c"),
      third: scopeFor("work-t"),
    };
    let archive!: () => void;
    function Page() {
      const [archived, setArchived] = useState(false);
      archive = () => setArchived(true);
      const third = {
        ...scopes.third,
        controller: { ...scopes.third.controller, dispositionLocked: archived },
      } as DraftReviewContextValue;
      return (
        <DraftReviewBoundary value={scopes.chat}>
          <EditorReviewScope value={scopes.editor}>
            <WorkReviewScopesProvider chat={scopes.chat} third={third}>
              <WorkChanges
                projectId="project-a"
                workId={"work-t" as ParsedRequestId}
                matchesSearch={() => true}
              />
            </WorkReviewScopesProvider>
          </EditorReviewScope>
        </DraftReviewBoundary>
      );
    }
    await withReactRoot(surface(<Page />), async () => {
      await applyAll();
      expect(scopes.third.controller.disposeDrafts).toHaveBeenCalledOnce();
      await act(async () => archive());
      await openMenu();
      expect((menuItem("Apply all 1 draft") as HTMLElement).getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect((menuItem("Discard all 1 draft") as HTMLElement).getAttribute("aria-disabled")).toBe(
        "true",
      );
    });
  });
});
