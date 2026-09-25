/**
 * A Favorite shows at once on every cached row of that chat; Favorites
 * membership is the server's, refetched once the command settles.
 */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { type ChatFeedData, flattenChatFeed } from "./project-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import { runFavoriteCommand } from "./thread-user-state-commands";

const api = vi.hoisted(() => ({ getProjectChatFeed: vi.fn(), updateThreadUserState: vi.fn() }));
vi.mock("@/client/api/projects-api", () => ({ getProjectChatFeed: api.getProjectChatFeed }));
vi.mock("@/client/api/threads-api", () => ({ updateThreadUserState: api.updateThreadUserState }));

const item: ProjectChatItem = {
  id: "chat",
  title: "Scene",
  agentName: null,
  work: null,
  lastMessagePreview: null,
  lastActivityAt: "2026-09-24T12:00:00.000Z",
  actionRequired: false,
  isFavorite: false,
};
const page = (items: ProjectChatItem[]) => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [null],
});
const allKey = projectQueryKeys.chatFeedFilter("project", { favorite: false, search: null });
const searchKey = projectQueryKeys.chatFeedFilter("project", { favorite: false, search: "sc" });
const favoriteKey = projectQueryKeys.chatFeedFilter("project", { favorite: true, search: null });
const rows = (client: QueryClient, key: readonly unknown[]) =>
  flattenChatFeed(client.getQueryData<ChatFeedData>(key));

it("projects a Favorite in place and refetches only Favorites membership", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(allKey, page([item]));
  client.setQueryData(searchKey, page([item]));
  client.setQueryData(favoriteKey, page([]));
  api.updateThreadUserState.mockResolvedValueOnce({ threadId: item.id, isFavorite: true });

  const adding = runFavoriteCommand(client, "project", item.id, true);
  expect(rows(client, allKey)).toMatchObject([{ id: "chat", isFavorite: true }]);
  expect(rows(client, searchKey)).toMatchObject([{ id: "chat", isFavorite: true }]);
  // Membership is not guessed: a search or Favorites page is only what the server returned.
  expect(rows(client, favoriteKey)).toEqual([]);
  await adding;

  const state = (key: readonly unknown[]) => client.getQueryCache().find({ queryKey: key })?.state;
  expect(state(favoriteKey)?.isInvalidated).toBe(true);
  expect(state(allKey)?.isInvalidated).toBe(false);
  expect(state(searchKey)?.isInvalidated).toBe(false);
});

it("rolls a failed Favorite back on every cached row", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(favoriteKey, page([{ ...item, isFavorite: true }]));
  api.updateThreadUserState.mockRejectedValueOnce(new Error("offline"));

  const removing = runFavoriteCommand(client, "project", item.id, false);
  expect(rows(client, favoriteKey)).toMatchObject([{ id: "chat", isFavorite: false }]);
  await removing;
  expect(rows(client, favoriteKey)).toMatchObject([{ id: "chat", isFavorite: true }]);
});
