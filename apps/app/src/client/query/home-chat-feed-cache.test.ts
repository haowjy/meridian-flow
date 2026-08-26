import type { HomeChatFeedPage, ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  groupHomeFeed,
  type HomeFeedData,
  projectHomePage,
  projectHomeThread,
} from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";

const item = (id: string, favorite = false): ProjectChatItem => ({
  id,
  title: id,
  work: null,
  lastMessagePreview: null,
  lastActivityAt: `2026-08-1${id === "a" ? "3" : "2"}T00:00:00.000Z`,
  attention: "unread",
  isFavorite: favorite,
});
const page = (
  featured: HomeChatFeedPage["featured"],
  items: ProjectChatItem[],
  cursor: string | null = null,
): HomeChatFeedPage => ({ featured, recentChats: { items, nextCursor: cursor } });

describe("Home feed projection", () => {
  it("keeps Continue, Favorite, and paged Recent exclusive", () => {
    const a = item("a", true),
      b = item("b", true),
      c = item("c");
    const data: HomeFeedData = {
      pageParams: [null, "next"],
      pages: [page({ continueChat: a, favoriteChats: [a, b] }, [b, c], "next"), page(null, [c, a])],
    };
    expect(groupHomeFeed(data)).toEqual({ continueChat: a, favorites: [b], recent: [c] });
  });

  it("moves only the affected Home thread between categories", () => {
    const client = new QueryClient();
    const key = projectQueryKeys.homeFeed("p");
    const untouched = item("b");
    client.setQueryData<HomeFeedData>(key, {
      pageParams: [null],
      pages: [page({ continueChat: null, favoriteChats: [] }, [item("a"), untouched])],
    });
    projectHomeThread(client, "p", "a", (current) => ({ ...current, isFavorite: true }));
    const projected = groupHomeFeed(client.getQueryData(key));
    expect(projected.favorites.map(({ id }) => id)).toEqual(["a"]);
    expect(projected.recent).toEqual([untouched]);
  });

  it("projects a stale arriving page before React Query caches it", () => {
    const projected = projectHomePage(
      page({ continueChat: null, favoriteChats: [] }, [item("a")]),
      (current) => ({ ...current, isFavorite: true, attention: "none" }),
    );
    expect(projected.featured?.favoriteChats[0]).toMatchObject({
      id: "a",
      isFavorite: true,
      attention: "none",
    });
    expect(projected.recentChats.items).toEqual([]);
  });
});
