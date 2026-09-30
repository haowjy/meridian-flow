// @vitest-environment jsdom
/** A chat in an archived Work keeps its composer, with the archived notice above it. */
import type { Work } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ChatScreen } from "./ChatScreen";

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
// The transcript and composer are ChatView's; this seam is the strip it frames above the composer.
vi.mock("@/features/chat/ChatView", () => ({
  ChatView: ({ composerStrip }: { composerStrip?: React.ReactNode }) => (
    <footer>
      {composerStrip}
      <textarea aria-label="Message" />
    </footer>
  ),
}));
vi.mock("@/client/query/work-command-store", () => ({
  useWorkMutations: () => ({ archive: vi.fn(), unarchive: vi.fn() }),
}));
vi.mock("@/client/query/work-command-selectors", () => ({
  useWorkCommandFailures: () => new Map(),
}));

const WORK = {
  id: "work-1",
  slug: "arc",
  name: "Arc",
  status: null,
  archivedAt: null,
} as unknown as Work;

function renderChat(work: Work) {
  return (
    <ChatScreen projectId="project-1" threadId="thread-1" activeWork={work} availableWorks={[]} />
  );
}

describe("ChatScreen", () => {
  it("shows the archived notice above a live composer when the chat's Work is archived", async () => {
    await withReactRoot(renderChat({ ...WORK, archivedAt: "2026-09-02T00:00:00.000Z" }), () => {
      const footer = document.querySelector("footer");
      expect(footer?.firstElementChild?.textContent).toContain("This Work is archived.");
      expect(footer?.lastElementChild?.tagName).toBe("TEXTAREA");
      expect(
        [...document.querySelectorAll("button")].some((b) => b.textContent === "Unarchive"),
      ).toBe(true);
    });
  });
});
