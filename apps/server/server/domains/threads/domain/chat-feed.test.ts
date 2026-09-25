/** Flat feed pagination includes favorites without duplicating or dropping equal-activity rows. */
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { getProjectChatFeedPage } from "./chat-feed.js";

afterEach(() => vi.useRealTimers());

it("pages All and Favorites independently over the same activity order", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
  const repos = createInMemoryRepositories();
  const ids: string[] = [];
  for (let index = 0; index < 34; index++) {
    const thread = await repos.threads.create({ projectId: "project", userId: "user" });
    ids.push(thread.id);
    if (index < 30)
      await repos.threadUserState.update({
        threadId: thread.id as ThreadId,
        userId: "user" as UserId,
        isFavorite: true,
      });
  }
  const input = { repository: repos.chatFeed, projectId: "project", userId: "user" };
  const first = await getProjectChatFeedPage(input);
  const second = await getProjectChatFeedPage({ ...input, cursor: first.nextCursor });
  expect(first.items).toHaveLength(24);
  expect(second.nextCursor).toBeNull();
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
    [...ids].sort().reverse(),
  );

  const favorites = await getProjectChatFeedPage({ ...input, favorite: true });
  const moreFavorites = await getProjectChatFeedPage({
    ...input,
    favorite: true,
    cursor: favorites.nextCursor,
  });
  expect(favorites.items).toHaveLength(24);
  expect(moreFavorites.items).toHaveLength(6);
  expect(moreFavorites.nextCursor).toBeNull();
  expect([...favorites.items, ...moreFavorites.items].map((item) => item.id)).toEqual(
    ids.slice(0, 30).sort().reverse(),
  );
});
