import type { HomeChatFeedPage, HomeChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  createHomeFeedCacheController,
  groupHomeFeed,
  type HomeFeedData,
} from "./home-chat-feed-cache";

const item = (id: string, favorite = false): HomeChatItem => ({
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
  items: HomeChatItem[],
  cursor: string | null = null,
): HomeChatFeedPage => ({ featured, recentChats: { items, nextCursor: cursor } });
const response = (attention: HomeChatItem["attention"], favorite = false) => ({
  threadId: "a",
  isFavorite: favorite,
  manuallyUnread: attention === "unread",
  lastOpenedAt: null,
  attention,
});

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

  it("rolls back only the failed field while retaining overlapping state", () => {
    const client = new QueryClient();
    const key = ["projects", "p", "home-feed"];
    client.setQueryData(key, {
      pageParams: [null],
      pages: [page({ continueChat: null, favoriteChats: [] }, [item("a")])],
    });
    const controller = createHomeFeedCacheController(client, "p");
    const favorite = controller.command("a", "isFavorite", true);
    controller.command("a", "isUnread", false);
    favorite.fail();
    const projected = groupHomeFeed(client.getQueryData(key));
    expect(projected.favorites).toEqual([]);
    expect(projected.recent[0]).toMatchObject({ isFavorite: false, attention: "none" });
  });

  it("does not let an older failed command roll back a newer desired state", () => {
    const client = new QueryClient();
    const key = ["projects", "p", "home-feed"];
    client.setQueryData(key, {
      pageParams: [null],
      pages: [page({ continueChat: null, favoriteChats: [] }, [item("a")])],
    });
    const controller = createHomeFeedCacheController(client, "p");
    const old = controller.command("a", "isFavorite", true);
    controller.command("a", "isFavorite", false);
    old.fail();
    expect(groupHomeFeed(client.getQueryData(key)).recent[0]?.isFavorite).toBe(false);
  });

  it.each([true, false])("never downgrades action-required for desired unread %s", (value) => {
    const client = new QueryClient();
    const action = { ...item("a"), attention: "actionRequired" as const };
    client.setQueryData(["projects", "p", "home-feed"], {
      pageParams: [null],
      pages: [page({ continueChat: action, favoriteChats: [] }, [])],
    });
    const command = createHomeFeedCacheController(client, "p").command("a", "isUnread", value);
    expect(
      groupHomeFeed(client.getQueryData(["projects", "p", "home-feed"])).continueChat?.attention,
    ).toBe("actionRequired");
    command.fail();
    expect(
      groupHomeFeed(client.getQueryData(["projects", "p", "home-feed"])).continueChat?.attention,
    ).toBe("actionRequired");
  });

  it("reconciles authoritative mutation fields and trusts the first post-ack request", () => {
    const client = new QueryClient();
    const key = ["projects", "p", "home-feed"];
    client.setQueryData(key, {
      pageParams: [null],
      pages: [page({ continueChat: null, favoriteChats: [] }, [item("a")])],
    });
    const controller = createHomeFeedCacheController(client, "p");
    const before = controller.beginRequest();
    const command = controller.command("a", "isFavorite", true);
    command.succeed(response("actionRequired", true));
    const after = controller.beginRequest();
    expect(
      controller.merge(page(null, [{ ...item("a"), isFavorite: false, attention: "none" }]), after)
        .recentChats.items[0],
    ).toMatchObject({ isFavorite: false, attention: "none" });
    expect(
      controller.merge(page({ continueChat: null, favoriteChats: [] }, [item("a")]), before)
        .featured?.favoriteChats[0]?.isFavorite,
    ).toBe(true);
    controller.settleRequest(after);
    controller.settleRequest(before);
  });

  it("lets later authoritative truth replace a field-scoped failure rollback", () => {
    const client = new QueryClient();
    client.setQueryData(["projects", "p", "home-feed"], {
      pageParams: [null],
      pages: [page({ continueChat: null, favoriteChats: [] }, [item("a")])],
    });
    const controller = createHomeFeedCacheController(client, "p");
    controller.command("a", "isFavorite", true).fail();
    const request = controller.beginRequest();
    expect(
      controller.merge(
        page({ continueChat: null, favoriteChats: [] }, [{ ...item("a"), isFavorite: true }]),
        request,
      ).featured?.favoriteChats[0]?.isFavorite,
    ).toBe(true);
    controller.settleRequest(request);
  });
});
