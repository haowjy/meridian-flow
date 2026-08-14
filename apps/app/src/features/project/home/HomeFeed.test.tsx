/** Rendered contracts for the deep Home feed presentation boundary. */
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeFeed } from "./HomeFeed";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => children,
}));

const item = (id: string, favorite = false): HomeChatItem => ({
  id,
  title: id,
  work: null,
  lastMessagePreview: "Preview",
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  attention: "none",
  isFavorite: favorite,
});
const cardProps = {
  now: Date.now(),
  onOpen: vi.fn(),
  onFavorite: vi.fn(),
  onUnread: vi.fn(async () => true),
  getCommandState: vi.fn(() => ({ pending: false, error: null, outcome: null })),
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
  fetchNextPage: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
};

describe("HomeFeed", () => {
  it("owns Continue, Favorite, Recent, grids, and the sentinel", async () => {
    await withReactRoot(
      <HomeFeed
        feed={base}
        cardProps={cardProps}
        newChat={<button type="button">New chat</button>}
      />,
      () => {
        const container = document.getElementById("root") as HTMLElement;
        expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
          "Continue",
          "Favorite chats",
          "Recent chats",
        ]);
        expect(container.querySelectorAll("[data-home-card]")).toHaveLength(3);
        expect(container.querySelector("[aria-hidden].h-px")).not.toBeNull();
      },
    );
  });
  it("renders initial, empty, page-loading, and page-error recovery states", async () => {
    await withReactRoot(
      <HomeFeed feed={{ ...base, isPending: true }} cardProps={cardProps} newChat={null} />,
      () =>
        expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading chats"),
    );
    await withReactRoot(
      <HomeFeed
        feed={{ ...base, grouped: { continueChat: null, favorites: [], recent: [] } }}
        cardProps={cardProps}
        newChat={<button type="button">New chat</button>}
        newChatError={<div role="alert">Create failed</div>}
      />,
      () => {
        expect(document.body.textContent).toContain("Start a chat");
        expect(document.body.textContent).toContain("Create failed");
      },
    );
    await withReactRoot(
      <HomeFeed
        feed={{ ...base, isFetchingNextPage: true }}
        cardProps={cardProps}
        newChat={null}
      />,
      () =>
        expect(document.querySelector('[role="status"]')?.textContent).toContain(
          "Loading more chats",
        ),
    );
    const retry = vi.fn(async () => undefined);
    await withReactRoot(
      <HomeFeed
        feed={{ ...base, isFetchNextPageError: true, fetchNextPage: retry }}
        cardProps={cardProps}
        newChat={null}
      />,
      async () => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent === "Retry",
        );
        await act(async () => button?.click());
        expect(retry).toHaveBeenCalledOnce();
        expect(document.querySelector("[aria-hidden].h-px")).toBeNull();
      },
    );
  });
});
