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
  getCommandState: vi.fn(() => ({ pending: false, error: null }) as const),
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
  it("owns one-column Continue, Favorite, and Recent lists plus the sentinel", async () => {
    await withReactRoot(<HomeFeed feed={base} cardProps={cardProps} />, () => {
      const container = document.getElementById("root") as HTMLElement;
      expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
        "Continue",
        "Favorite",
        "Recent chats",
      ]);
      expect(container.querySelectorAll("[data-home-card]")).toHaveLength(3);
      expect(container.querySelectorAll("ul")).toHaveLength(2);
      const continueCard = container.querySelector('[data-home-card="Continue"]');
      expect(continueCard?.querySelector('[data-slot="card-title"]')?.textContent).toBe("Continue");
      expect(continueCard?.querySelector('[data-slot="card-footer"]')?.textContent).toContain(
        "Work:",
      );
      expect(container.querySelector("[aria-hidden].h-px")).not.toBeNull();
    });
  });
  it("renders initial, empty, page-loading, and page-error recovery states", async () => {
    await withReactRoot(
      <HomeFeed feed={{ ...base, isPending: true }} cardProps={cardProps} />,
      () => {
        const status = document.querySelector('[role="status"]');
        expect(status?.textContent).toContain("Loading chats");
      },
    );
    await withReactRoot(
      <HomeFeed
        feed={{ ...base, grouped: { continueChat: null, favorites: [], recent: [] } }}
        cardProps={cardProps}
      />,
      () => {
        expect(document.body.textContent).toContain(
          "Your chats will appear here after you send a message.",
        );
      },
    );
    await withReactRoot(
      <HomeFeed feed={{ ...base, isError: true, data: null }} cardProps={cardProps} />,
      () => {
        expect(document.querySelector("h2")?.textContent).toBe("Chats couldn’t load");
        expect(document.querySelector("h1")).toBeNull();
      },
    );
    await withReactRoot(
      <HomeFeed feed={{ ...base, isFetchingNextPage: true }} cardProps={cardProps} />,
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
