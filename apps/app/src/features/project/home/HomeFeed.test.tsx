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
const rowProps = {
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
    await withReactRoot(<HomeFeed feed={base} rowProps={rowProps} />, () => {
      const container = document.getElementById("root") as HTMLElement;
      expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
        "Continue",
        "Favorite",
        "Recent chats",
      ]);
      expect(container.querySelectorAll("[data-home-row]")).toHaveLength(3);
      expect(container.querySelectorAll("ul")).toHaveLength(3);
      const continueRow = container.querySelector('[data-home-row="Continue"]');
      expect(continueRow?.textContent).toContain("Continue");
      expect(continueRow?.textContent).toContain("Work unavailable");
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
      <HomeFeed feed={{ ...base, isPending: true }} rowProps={rowProps} />,
      () => {
        const status = document.querySelector('[role="status"]');
        expect(status?.textContent).toContain("Loading chats");
      },
    );
    await withReactRoot(
      <HomeFeed
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
      <HomeFeed feed={{ ...base, isError: true, data: null, refetch }} rowProps={rowProps} />,
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
      <HomeFeed feed={{ ...base, isFetchingNextPage: true }} rowProps={rowProps} />,
      () =>
        expect(document.querySelector('[role="status"]')?.textContent).toContain(
          "Loading more chats",
        ),
    );
    const retry = vi.fn(async () => undefined);
    await withReactRoot(
      <HomeFeed
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
    const errorProps = {
      ...rowProps,
      getCommandState: vi.fn((_id: string, field: "isFavorite" | "isUnread") => ({
        pending: false as const,
        error: field === "isUnread" ? new Error("offline") : null,
      })),
    };
    await withReactRoot(<HomeFeed feed={base} rowProps={errorProps} />, async () => {
      const row = document.querySelector('[data-home-row="Continue"]') as HTMLElement;
      expect(row.textContent).toContain("Read status wasn’t saved. Open actions to retry.");
      expect(row.querySelector('[role="alert"]')).toBeNull();
      const actions = row.querySelector('button[aria-invalid="true"]') as HTMLButtonElement;
      expect(actions.getAttribute("aria-describedby")).toContain("home-read-error-Continue");
    });
  });
});
