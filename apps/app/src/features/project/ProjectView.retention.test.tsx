// @vitest-environment jsdom
/** Desktop composition retains private child identity without admitting stale route publishers. */
import { act, type ReactNode, useState } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DesktopProject, type ReviewScopedProjectProps } from "./ProjectView";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  msg: (strings: TemplateStringsArray) => ({ id: strings.join("") }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/features/chat/DraftReviewProvider", async (original) => ({
  ...(await original<object>()),
  DraftReviewBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/features/chat/review-prose-focus", () => ({
  useReviewProseFocus: () => ({ collapsedSlots: [], release() {} }),
}));
vi.mock("@/features/chat/conversation-reveal", () => ({ useConversationRevealRouting() {} }));
vi.mock("./shell/LeftSidebar", () => ({ LeftSidebar: () => null }));
vi.mock("./shell/ContextSidebar", () => ({ ContextSidebar: () => null }));
vi.mock("./ChatPaneController", () => ({ ChatPaneController: () => null }));
vi.mock("./HomePaneController", () => ({
  HomePaneController: () => <div>Creation or collection</div>,
}));
vi.mock("./WorkPaneController", () => ({ WorkPaneController: () => null }));
vi.mock("./dock/editor-review-handoff", async (original) => ({
  ...(await original<object>()),
  EditorReviewIntentClaimant: () => null,
}));
vi.mock("./chat/ChatSurface", () => ({
  ChatSurface: ({ threadId, visible }: { threadId: string | null; visible: boolean }) =>
    threadId ? (
      <textarea
        key={threadId}
        data-chat={threadId}
        data-active={visible}
        defaultValue="Unsent existing chat"
      />
    ) : null,
}));
vi.mock("./ContextPaneController", () => ({
  ContextViewerSurfaceController: ({
    editorWorkId,
    activeContextPath,
    active,
  }: {
    editorWorkId: string | null;
    activeContextPath: string | null;
    active: boolean;
  }) => (
    <textarea
      data-editor={editorWorkId}
      data-path={activeContextPath}
      data-active={active}
      defaultValue="Live document"
    />
  ),
}));

it("parks the same desktop children through collection, creation and unavailable requests", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const initial = {
    projectId: "project",
    activeScreen: "context",
    activeThreadId: "chat-a",
    chatWork: null,
    availableWorks: [],
    editorScope: { status: "ready", workId: "work-a", source: "route" },
    editorWorkId: "work-a",
    contextLive: true,
    activeContextScheme: "manuscript",
    activeContextPath: "/a.md",
    routeIssues: {},
    onSelectScreen: vi.fn(),
    onSelectThread: vi.fn(),
    onSelectDockThread: vi.fn(),
    onSelectContextPath: vi.fn(),
    onOpenContextTarget: vi.fn(),
    retryEditorWork: vi.fn(),
  } as unknown as ReviewScopedProjectProps;
  let change!: (patch: Partial<ReviewScopedProjectProps>) => void;
  function Harness() {
    window.matchMedia = matchMedia;
    const [props, setProps] = useState(initial);
    change = (patch) => setProps({ ...initial, ...patch });
    return <DesktopProject {...props} />;
  }
  try {
    await withReactRoot(<Harness />, async () => {
      const chat = document.querySelector('[data-chat="chat-a"]');
      const editor = document.querySelector('[data-editor="work-a"]');
      expect(chat).not.toBeNull();
      expect(editor).not.toBeNull();
      await act(async () =>
        change({
          activeContextPath: "/b.md",
          routeIssues: { editor: "loading" },
        }),
      );
      expect(document.querySelector('[data-editor="work-a"]')).toBe(editor);
      expect(editor?.getAttribute("data-path")).toBe("/a.md");
      expect(editor?.closest('[aria-hidden="true"]')).toBeNull();
      await act(async () => change({ activeContextPath: "/b.md" }));
      expect(editor?.getAttribute("data-path")).toBe("/b.md");
      await act(async () =>
        change({ activeScreen: "chat", activeThreadId: null, chatDestination: "chats" }),
      );
      expect(document.querySelector('[data-chat="chat-a"]')).toBe(chat);
      expect(chat?.getAttribute("data-active")).toBe("false");
      expect(document.querySelector('[data-editor="work-a"]')).toBe(editor);
      expect(editor?.getAttribute("data-active")).toBe("false");
      for (const issue of ["loading", "error", "unavailable"] as const) {
        await act(async () =>
          change({
            activeThreadId: null,
            editorScope: { status: issue, workId: "missing" },
            editorWorkId: null,
            contextLive: false,
            routeIssues: { chat: issue, editor: issue },
          }),
        );
        expect(document.querySelector('[data-chat="chat-a"]')).toBe(chat);
        expect(document.querySelector('[data-editor="work-a"]')).toBe(editor);
        expect(editor?.getAttribute("data-active")).toBe("false");
      }
      await act(async () => change({}));
      expect(document.querySelector('[data-editor="work-a"]')).toBe(editor);
      expect(editor?.getAttribute("data-active")).toBe("true");
      expect(document.querySelector('[data-chat="chat-a"]')).toBe(chat);
      await act(async () => change({ activeThreadId: "chat-b" }));
      expect(chat?.isConnected).toBe(false);
      expect(document.querySelector('[data-chat="chat-b"]')).not.toBeNull();
      expect(initial.onSelectThread).not.toHaveBeenCalled();
      expect(initial.onOpenContextTarget).not.toHaveBeenCalled();
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
