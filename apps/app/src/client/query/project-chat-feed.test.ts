/** Favorites membership follows local intent even when a pre-command page arrives late. */
import type { ProjectChatFeedPage, ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { flattenProjectFeed, type ProjectFeedData } from "./project-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import { runFavoriteCommand } from "./thread-user-state-commands";
import { projectChatFeedQueryOptions } from "./useProjectChatFeed";

const api = vi.hoisted(() => ({ getProjectChatFeed: vi.fn(), updateThreadUserState: vi.fn() }));
vi.mock("@/client/api/projects-api", () => ({ getProjectChatFeed: api.getProjectChatFeed }));
vi.mock("@/client/api/threads-api", () => ({ updateThreadUserState: api.updateThreadUserState }));

it("retains an added favorite across filter switching and a stale empty page", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  const allKey = [...projectQueryKeys.chatFeed("project"), { favorite: false }];
  const favoriteKey = [...projectQueryKeys.chatFeed("project"), { favorite: true }];
  client.setQueryData(allKey, { pages: [{ items: [item], nextCursor: null }], pageParams: [null] });
  client.setQueryData(favoriteKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [null],
  });
  let respond!: (page: ProjectChatFeedPage) => void;
  api.getProjectChatFeed.mockReturnValueOnce(
    new Promise((resolve) => {
      respond = resolve;
    }),
  );
  const staleRead = client.fetchInfiniteQuery(projectChatFeedQueryOptions(client, "project", true));
  api.updateThreadUserState.mockResolvedValueOnce({ threadId: item.id, isFavorite: true });
  await runFavoriteCommand(client, "project", item.id, true);
  expect(flattenProjectFeed(client.getQueryData<ProjectFeedData>(favoriteKey))).toMatchObject([
    { id: "chat", isFavorite: true },
  ]);
  respond({ items: [], nextCursor: null });
  await staleRead;
  expect(flattenProjectFeed(client.getQueryData<ProjectFeedData>(favoriteKey))).toMatchObject([
    { id: "chat", isFavorite: true },
  ]);

  api.updateThreadUserState.mockRejectedValueOnce(new Error("offline"));
  const removing = runFavoriteCommand(client, "project", item.id, false);
  expect(
    flattenProjectFeed(client.getQueryData<ProjectFeedData>(favoriteKey)).filter(
      (row) => row.isFavorite,
    ),
  ).toEqual([]);
  await removing;
  expect(flattenProjectFeed(client.getQueryData<ProjectFeedData>(favoriteKey))).toMatchObject([
    { id: "chat", isFavorite: true },
  ]);
});
