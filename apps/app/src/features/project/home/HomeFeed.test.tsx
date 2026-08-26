/** Rendered contracts for the deep Home feed presentation boundary. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HomeFeedNextPageIdentity } from "@/client/query/useHomeChatFeed";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeFeed } from "./HomeFeed";

const userState = vi.hoisted(() => ({ readError: undefined as Error | undefined }));

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock("@lingui/react", () => ({ useLingui: () => ({ i18n: { locale: "en" } }) }));
vi.mock("@/client/query/useProjectChatUserState", () => ({
  useProjectChatUserState: (_projectId: string, chat: ProjectChatItem) => ({
    item: chat,
    favorite: { pending: false },
    unread: { pending: false, error: userState.readError },
  }),
}));

const item = (id: string, favorite = false): ProjectChatItem => ({
  id,
  title: id,
  work: null,
  lastMessagePreview: "Preview",
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  attention: "none",
  isFavorite: favorite,
});
const rowProps = {
  now: Date.now(),
  onOpen: vi.fn(),
  onFavorite: vi.fn(),
  onUnread: vi.fn(async () => true),
};
const base = {
  isPending: false,
  isError: false,
  data: {},
  grouped: {
    continueChat: item("Continue"),
    favorites: [item("Favorite", true)],
    recent: [item("Recent")],
  },
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  nextPageIdentity: null,
  fetchNextPage: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
};

describe("HomeFeed", () => {
  it("requests each current cursor once across A to B to A replacements", async () => {
    const notifications: IntersectionObserverCallback[] = [];
    const observeSpy = vi.fn();
    const disconnectSpy = vi.fn();
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        notifications.push(callback);
      }
      observe(target: Element) {
        observeSpy(target);
      }
      disconnect() {
        disconnectSpy();
      }
    }
    globalThis.IntersectionObserver = TestIntersectionObserver as typeof IntersectionObserver;
    const fetchCursorA = vi.fn(async () => undefined);
    const fetchCursorB = vi.fn(async () => undefined);
    const cursorA = "project-1:cursor-a" as HomeFeedNextPageIdentity;
    const cursorB = "project-1:cursor-b" as HomeFeedNextPageIdentity;
    let replaceFeed!: (identity: HomeFeedNextPageIdentity, data: unknown) => void;
    function PaginationHarness() {
      const [state, setState] = useState<{
        identity: HomeFeedNextPageIdentity;
        data: unknown;
      }>({ identity: cursorA, data: { revision: 1 } });
      replaceFeed = (identity, data) => setState({ identity, data });
      return (
        <HomeFeed
          projectId="project-1"
          feed={{
            ...base,
            data: state.data,
            hasNextPage: true,
            nextPageIdentity: state.identity,
            fetchNextPage: state.identity === cursorA ? fetchCursorA : fetchCursorB,
          }}
          rowProps={rowProps}
        />
      );
    }
    await withReactRoot(<PaginationHarness />, async () => {
      const sentinel = document.querySelector("[data-home-feed-sentinel]") as HTMLElement;
      expect(observeSpy.mock.calls[0]?.[0]).toBe(sentinel);
      await act(async () => {
        notifications.at(-1)?.(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          undefined as never,
        );
        notifications.at(-1)?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          undefined as never,
        );
        notifications.at(-1)?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          undefined as never,
        );
      });
      const observerA = notifications.at(-1);
      expect(fetchCursorA).toHaveBeenCalledOnce();
      expect(fetchCursorB).not.toHaveBeenCalled();
      await act(async () => replaceFeed(cursorA, { optimisticRevision: 2 }));
      notifications.at(-1)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        undefined as never,
      );
      expect(fetchCursorA).toHaveBeenCalledOnce();
      await act(async () => replaceFeed(cursorB, { revision: 3 }));
      const observerB = notifications.at(-1);
      await act(async () => {
        observerA?.([{ isIntersecting: true } as IntersectionObserverEntry], undefined as never);
        observerB?.([{ isIntersecting: true } as IntersectionObserverEntry], undefined as never);
        observerA?.([{ isIntersecting: true } as IntersectionObserverEntry], undefined as never);
        observerB?.([{ isIntersecting: true } as IntersectionObserverEntry], undefined as never);
      });
      expect(fetchCursorA).toHaveBeenCalledOnce();
      expect(fetchCursorB).toHaveBeenCalledOnce();
      await act(async () => replaceFeed(cursorA, { authoritativeRevision: 4 }));
      const returnedObserverA = notifications.at(-1);
      await act(async () => {
        observerB?.([{ isIntersecting: true } as IntersectionObserverEntry], undefined as never);
        returnedObserverA?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          undefined as never,
        );
        observerB?.([{ isIntersecting: true } as IntersectionObserverEntry], undefined as never);
        returnedObserverA?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          undefined as never,
        );
      });
      expect(fetchCursorA).toHaveBeenCalledTimes(2);
      expect(fetchCursorB).toHaveBeenCalledOnce();
    });
    expect(disconnectSpy).toHaveBeenCalledTimes(3);
  });
  it("owns one-column Continue, Favorite, and Recent lists plus the sentinel", async () => {
    await withReactRoot(<HomeFeed projectId="project-1" feed={base} rowProps={rowProps} />, () => {
      const container = document.getElementById("root") as HTMLElement;
      expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
        "Continue",
        "Favorite",
        "Recent chats",
      ]);
      expect(container.querySelectorAll("[data-project-chat-row]")).toHaveLength(3);
      expect(container.querySelectorAll("ul")).toHaveLength(3);
      const continueRow = container.querySelector('[data-project-chat-row="Continue"]');
      expect(continueRow?.textContent).toContain("Continue");
      expect(continueRow?.textContent).toContain("Unavailable");
      expect(continueRow?.textContent).toContain("Preview");
      expect(continueRow?.querySelectorAll("button")).toHaveLength(2);
      expect(
        [...(continueRow?.querySelectorAll("button") ?? [])].map((button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual(["Open ", "Actions for "]);
      expect(container.querySelector("[data-home-feed-sentinel]")).not.toBeNull();
    });
  });
  it("renders initial, empty, page-loading, and page-error recovery states", async () => {
    await withReactRoot(
      <HomeFeed projectId="project-1" feed={{ ...base, isPending: true }} rowProps={rowProps} />,
      () => {
        const status = document.querySelector('[role="status"]');
        expect(status?.textContent).toContain("Loading chats");
      },
    );
    await withReactRoot(
      <HomeFeed
        projectId="project-1"
        feed={{ ...base, grouped: { continueChat: null, favorites: [], recent: [] } }}
        rowProps={rowProps}
      />,
      () => {
        expect(document.body.textContent).toContain(
          "Your chats will appear here after you send a message.",
        );
      },
    );
    const refetch = vi.fn(async () => undefined);
    await withReactRoot(
      <HomeFeed
        projectId="project-1"
        feed={{ ...base, isError: true, data: null, refetch }}
        rowProps={rowProps}
      />,
      async () => {
        expect(document.querySelector("h2")?.textContent).toBe("Chats couldn’t load");
        expect(document.querySelector("h1")).toBeNull();
        const retry = [...document.querySelectorAll("button")].find(
          (node) => node.textContent === "Retry",
        );
        await act(async () => retry?.click());
        expect(refetch).toHaveBeenCalledOnce();
      },
    );
    await withReactRoot(
      <HomeFeed
        projectId="project-1"
        feed={{ ...base, isFetchingNextPage: true }}
        rowProps={rowProps}
      />,
      () =>
        expect(document.querySelector('[role="status"]')?.textContent).toContain(
          "Loading more chats",
        ),
    );
    const retry = vi.fn(async () => undefined);
    await withReactRoot(
      <HomeFeed
        projectId="project-1"
        feed={{ ...base, isFetchNextPageError: true, fetchNextPage: retry }}
        rowProps={rowProps}
      />,
      async () => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent === "Retry",
        );
        await act(async () => button?.click());
        expect(retry).toHaveBeenCalledOnce();
        expect(document.querySelector("[data-home-feed-sentinel]")).toBeNull();
      },
    );
  });
  it("keeps read failure and retry in the existing overflow owner", async () => {
    userState.readError = new Error("offline");
    const errorProps = rowProps;
    await withReactRoot(
      <HomeFeed projectId="project-1" feed={base} rowProps={errorProps} />,
      async () => {
        const row = document.querySelector('[data-project-chat-row="Continue"]') as HTMLElement;
        expect(row.textContent).toContain("Read status wasn’t saved. Open actions to retry.");
        expect(row.querySelector('[role="alert"]')).toBeNull();
        const actions = row.querySelector('button[aria-invalid="true"]') as HTMLButtonElement;
        const describedBy = actions.getAttribute("aria-describedby");
        expect(describedBy).toBeTruthy();
        expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
          "Read status wasn’t saved",
        );
      },
    );
  });
});
