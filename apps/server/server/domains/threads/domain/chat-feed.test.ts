/** Flat feed pagination includes favorites without duplicating or dropping equal-activity rows. */
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createInMemoryWorkRepository } from "../../projects/adapters/work-repository/in-memory.js";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { getProjectChatFeedPage, ProjectChatFeedWorkUnavailableError } from "./chat-feed.js";

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

it("searches titles case-insensitively, literally, and within Favorites", async () => {
  const repos = createInMemoryRepositories();
  const titles = ["Sect Trials", "The sect's hidden map", "50% off pills", "Unrelated"];
  const threads = [];
  for (const title of titles) {
    const thread = await repos.threads.create({ projectId: "project", userId: "user" });
    await repos.threads.updateTitle(thread.id as ThreadId, title);
    threads.push(thread);
  }
  await repos.threadUserState.update({
    threadId: threads[1]?.id as ThreadId,
    userId: "user" as UserId,
    isFavorite: true,
  });
  const input = { repository: repos.chatFeed, projectId: "project", userId: "user" };
  const titlesOf = async (options: { search: string; favorite?: boolean }) =>
    (await getProjectChatFeedPage({ ...input, ...options })).items.map((item) => item.title).sort();

  expect(await titlesOf({ search: "  SECT " })).toEqual(["Sect Trials", "The sect's hidden map"]);
  expect(await titlesOf({ search: "sect", favorite: true })).toEqual(["The sect's hidden map"]);
  expect(await titlesOf({ search: "50%" })).toEqual(["50% off pills"]);
  expect((await getProjectChatFeedPage({ ...input, search: "   " })).items).toHaveLength(4);
});

it("filters the project feed by Work before search, favorites, and cursor pagination", async () => {
  const works = createInMemoryWorkRepository();
  const work = await works.create({ projectId: "project" as ProjectId, name: "The sect" });
  const otherWork = await works.create({ projectId: "project" as ProjectId, name: "Other" });
  const repos = createInMemoryRepositories({ works });
  const matchingFavorite = await repos.threads.create({
    projectId: "project",
    userId: "user",
    title: "Sect favorite",
  });
  const matchingNotFavorite = await repos.threads.create({
    projectId: "project",
    userId: "user",
    title: "Sect draft",
  });
  const otherMember = await repos.threads.create({
    projectId: "project",
    userId: "user",
    title: "Other favorite",
  });
  const anotherWork = await repos.threads.create({
    projectId: "project",
    userId: "user",
    title: "Sect in another Work",
  });
  for (const thread of [matchingFavorite, matchingNotFavorite, otherMember]) {
    await repos.threadWorks.addMembership(thread.id as ThreadId, work.id as WorkId, true);
  }
  await repos.threadWorks.addMembership(anotherWork.id as ThreadId, otherWork.id as WorkId, true);
  await repos.threadUserState.update({
    threadId: matchingFavorite.id as ThreadId,
    userId: "user" as UserId,
    isFavorite: true,
  });
  await repos.threadUserState.update({
    threadId: otherMember.id as ThreadId,
    userId: "user" as UserId,
    isFavorite: true,
  });
  await repos.threadUserState.update({
    threadId: anotherWork.id as ThreadId,
    userId: "user" as UserId,
    isFavorite: true,
  });

  const input = {
    repository: repos.chatFeed,
    works,
    projectId: "project",
    userId: "user",
    workId: work.id,
  };
  expect((await getProjectChatFeedPage(input)).items.map((item) => item.title).sort()).toEqual(
    ["Other favorite", "Sect draft", "Sect favorite"].sort(),
  );
  expect(
    (await getProjectChatFeedPage({ ...input, search: "sect", favorite: true })).items.map(
      (item) => item.title,
    ),
  ).toEqual(["Sect favorite"]);

  const first = await repos.chatFeed.queryPage({
    projectId: "project",
    userId: "user",
    after: null,
    limit: 1,
    favorite: true,
    search: "sect",
    workId: work.id as WorkId,
  });
  const firstItem = first[0];
  if (!firstItem) throw new Error("Expected a Work-filtered first page");
  const rest = await repos.chatFeed.queryPage({
    projectId: "project",
    userId: "user",
    after: { sortAt: firstItem.lastActivityAt, threadId: firstItem.id as ThreadId },
    limit: 10,
    favorite: true,
    search: "sect",
    workId: work.id as WorkId,
  });
  expect([...first, ...rest].map((item) => item.title)).toEqual(["Sect favorite"]);
});

it("rejects a Work filter owned by a different project", async () => {
  const works = createInMemoryWorkRepository();
  const foreignWork = await works.create({
    projectId: "another-project" as ProjectId,
    name: "Elsewhere",
  });
  const repos = createInMemoryRepositories({ works });

  await expect(
    getProjectChatFeedPage({
      repository: repos.chatFeed,
      works,
      projectId: "project",
      userId: "user",
      workId: foreignWork.id,
    }),
  ).rejects.toBeInstanceOf(ProjectChatFeedWorkUnavailableError);
});

it("keeps a parked assistant question action-required after a visible writer follow-up", async () => {
  const repos = createInMemoryRepositories();
  const thread = await repos.threads.create({ projectId: "project", userId: "user" });
  const parkedAssistant = await repos.turns.create({
    threadId: thread.id as ThreadId,
    role: "assistant",
    origin: "assistant",
    status: "waiting_interrupt",
  });
  const writerTurn = await repos.turns.create({
    threadId: thread.id as ThreadId,
    prevTurnId: parkedAssistant.id,
    role: "user",
    origin: "writer",
    status: "complete",
  });
  await repos.blocks.create({
    turnId: writerTurn.id,
    blockType: "text",
    sequence: 0,
    textContent: "one more detail",
  });

  const [item] = await repos.chatFeed.queryPage({
    projectId: "project",
    userId: "user",
    after: null,
    limit: 10,
    favorite: false,
    search: null,
  });

  expect(item).toMatchObject({
    actionRequired: true,
    lastMessagePreview: "one more detail",
  });
  await expect(repos.threads.listByProject("project")).resolves.toMatchObject([
    { actionRequired: true },
  ]);
});
