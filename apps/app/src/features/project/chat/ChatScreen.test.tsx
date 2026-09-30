// @vitest-environment jsdom
/** A chat in an archived Work shows its transcript with the archived notice in the composer's place. */
import type { Work } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ChatScreen } from "./ChatScreen";

vi.mock("@lingui/core/macro", () => {
  const join = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, "");
  return { t: join, msg: join };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [] }),
}));
vi.mock("@/client/query/useThreadSnapshotSync", () => ({
  useThreadSnapshotSync: () => ({
    activateProjection: () => true,
    thread: null,
    liveState: null,
    nextSeq: null,
    snapshot: null,
    isError: false,
    settled: true,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/chat/useThreadActivity", () => ({
  useThreadActivity: () => ({ activity: { descendants: [] } }),
}));
vi.mock("../routing/chat-navigation", () => ({
  useChatNavigation: () => ({ openChat: vi.fn() }),
}));
// New chat's composer is not under test; keep its module graph out.
vi.mock("@/features/chat/CreationComposer", () => ({ CreationComposer: () => null }));
vi.mock("./ProjectChatContextNavigationProvider", () => ({
  ProjectChatContextNavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// The transcript and composer are ChatView's; this seam is which of the two footers it gets.
vi.mock("@/features/chat/ChatView", () => ({
  ChatView: ({ composerNotice }: { composerNotice?: React.ReactNode }) => (
    <footer>{composerNotice ?? <textarea aria-label="Message" />}</footer>
  ),
}));
vi.mock("@/client/query/work-command-store", () => ({
  useWorkMutations: () => ({ archive: vi.fn(), unarchive: vi.fn() }),
}));
vi.mock("@/client/query/work-command-selectors", () => ({
  useWorkCommandFailures: () => new Map(),
}));

const WORK = { id: "work-1", slug: "arc", name: "Arc", status: "active" } as unknown as Work;

function renderChat(work: Work) {
  return (
    <ChatScreen projectId="project-1" threadId="thread-1" activeWork={work} availableWorks={[]} />
  );
}

describe("ChatScreen", () => {
  it("replaces the composer with the archived notice when the chat's Work is archived", async () => {
    await withReactRoot(renderChat({ ...WORK, status: "archived" }), () => {
      expect(document.querySelector("textarea")).toBeNull();
      expect(document.querySelector("footer")?.textContent).toContain("This Work is archived.");
      expect(
        [...document.querySelectorAll("button")].some((b) => b.textContent === "Unarchive"),
      ).toBe(true);
    });
  });

  it("keeps the composer while the chat's Work is active", async () => {
    await withReactRoot(renderChat(WORK), () => {
      expect(document.querySelector("textarea")).not.toBeNull();
      expect(document.body.textContent).not.toContain("archived");
    });
  });
});
