/**
 * Shared behavior contract for `ProjectChatFeedRepository` and
 * `WorkChatFeedRepository`, run against both the in-memory and Drizzle
 * adapters. The in-memory adapter's search/favorite filters are plain
 * JS predicates; the Drizzle adapter's are ILIKE and a real join. These
 * scenarios exist to keep both honest, especially search metacharacters and
 * ILIKE case-folding, which only the Drizzle adapter can get wrong.
 */
import type { ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { expect } from "vitest";
import type { ThreadRepositories } from "../../ports/repositories.js";

export type ChatFeedConformanceHarness = {
  repos: Pick<
    ThreadRepositories,
    "threads" | "threadUserState" | "threadWorks" | "chatFeed" | "workChatFeed"
  >;
  projectId: string;
  userId: string;
  /** Returns a Work id valid as a primary-membership target in this project. */
  createWork(): Promise<string>;
};

async function createTitledThread(
  h: ChatFeedConformanceHarness,
  id: string,
  title: string,
): Promise<void> {
  await h.repos.threads.create({
    id: id as ThreadId,
    userId: h.userId as UserId,
    projectId: h.projectId,
    title,
  });
}

async function pageIds(
  h: ChatFeedConformanceHarness,
  options: { favorite?: boolean; search?: string | null } = {},
): Promise<string[]> {
  const page = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: null,
    limit: 50,
    favorite: options.favorite ?? false,
    search: options.search ?? null,
  });
  return page.map((item) => item.id);
}

/** Equal-activity rows (a real tie, not an approximation) page by descending id. */
export async function expectChatFeedTiesContract(h: ChatFeedConformanceHarness): Promise<void> {
  const ids = [
    "00000000-0000-4000-8000-00000000a001",
    "00000000-0000-4000-8000-00000000a002",
    "00000000-0000-4000-8000-00000000a003",
  ];
  for (const id of ids) await createTitledThread(h, id, id);
  const expectedOrder = [...ids].sort().reverse();

  const firstPage = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: null,
    limit: 2,
    favorite: false,
    search: null,
  });
  expect(firstPage.map((item) => item.id)).toEqual(expectedOrder.slice(0, 2));

  const last = firstPage[1];
  if (!last) throw new Error("Expected a second row on the tied first page");
  const secondPage = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: { sortAt: last.lastActivityAt, threadId: last.id as ThreadId },
    limit: 2,
    favorite: false,
    search: null,
  });
  expect(secondPage.map((item) => item.id)).toEqual(expectedOrder.slice(2));
}

/** Favorites narrows the feed without changing the shared activity order. */
export async function expectChatFeedFavoriteFilterContract(
  h: ChatFeedConformanceHarness,
): Promise<void> {
  const favoriteId = "00000000-0000-4000-8000-00000000b001";
  const otherId = "00000000-0000-4000-8000-00000000b002";
  await createTitledThread(h, favoriteId, "Favorite chat");
  await createTitledThread(h, otherId, "Other chat");
  await h.repos.threadUserState.update({
    threadId: favoriteId as ThreadId,
    userId: h.userId as UserId,
    isFavorite: true,
  });

  expect(await pageIds(h, { favorite: true })).toEqual([favoriteId]);
  expect(await pageIds(h)).toEqual(expect.arrayContaining([favoriteId, otherId]));
}

/**
 * ILIKE metacharacters (`%`, `_`, `\`) in the writer's query match literally,
 * CJK titles are found by substring, and matching case-folds.
 */
export async function expectChatFeedSearchSemanticsContract(
  h: ChatFeedConformanceHarness,
): Promise<void> {
  const percent = "00000000-0000-4000-8000-00000000c001";
  const underscore = "00000000-0000-4000-8000-00000000c002";
  const backslash = "00000000-0000-4000-8000-00000000c003";
  const cjk = "00000000-0000-4000-8000-00000000c004";
  const caseFold = "00000000-0000-4000-8000-00000000c005";
  const decoy = "00000000-0000-4000-8000-00000000c006";
  await createTitledThread(h, percent, "50% off pills");
  await createTitledThread(h, underscore, "under_score notes");
  await createTitledThread(h, backslash, "C:\\map\\vault");
  await createTitledThread(h, cjk, "宗门试炼 Chapter 1");
  await createTitledThread(h, caseFold, "The Sect's Hidden Map");
  await createTitledThread(h, decoy, "Unrelated");

  expect(await pageIds(h, { search: "50%" })).toEqual([percent]);
  expect(await pageIds(h, { search: "der_sc" })).toEqual([underscore]);
  expect(await pageIds(h, { search: "\\map\\" })).toEqual([backslash]);
  expect(await pageIds(h, { search: "宗门" })).toEqual([cjk]);
  expect(await pageIds(h, { search: "SECT" })).toEqual([caseFold]);
}

/** A cursor minted while a filter was active pages correctly under that same filter. */
export async function expectChatFeedCursorAcrossFilterContract(
  h: ChatFeedConformanceHarness,
): Promise<void> {
  const ids = [
    "00000000-0000-4000-8000-00000000d001",
    "00000000-0000-4000-8000-00000000d002",
    "00000000-0000-4000-8000-00000000d003",
  ];
  for (const id of ids) await createTitledThread(h, id, "Filtered sect chat");
  for (const id of ids) {
    await h.repos.threadUserState.update({
      threadId: id as ThreadId,
      userId: h.userId as UserId,
      isFavorite: true,
    });
  }
  const expectedOrder = [...ids].sort().reverse();

  const firstPage = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: null,
    limit: 2,
    favorite: true,
    search: "sect",
  });
  expect(firstPage.map((item) => item.id)).toEqual(expectedOrder.slice(0, 2));
  const last = firstPage[1];
  if (!last) throw new Error("Expected a second favorited row on the filtered first page");

  const secondPage = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: { sortAt: last.lastActivityAt, threadId: last.id as ThreadId },
    limit: 2,
    favorite: true,
    search: "sect",
  });
  expect(secondPage.map((item) => item.id)).toEqual(expectedOrder.slice(2));
}

/** The Work feed shares the Project feed's row shape and activity order, scoped to membership. */
export async function expectWorkChatFeedContract(h: ChatFeedConformanceHarness): Promise<void> {
  const memberA = "00000000-0000-4000-8000-00000000e001";
  const memberB = "00000000-0000-4000-8000-00000000e002";
  const nonMember = "00000000-0000-4000-8000-00000000e003";
  await createTitledThread(h, memberA, "Work chat A");
  await createTitledThread(h, memberB, "Work chat B");
  await createTitledThread(h, nonMember, "Not in this Work");
  const workId = await h.createWork();
  await h.repos.threadWorks.addMembership(memberA as ThreadId, workId as WorkId, true);
  await h.repos.threadWorks.addMembership(memberB as ThreadId, workId as WorkId, true);

  const page = await h.repos.workChatFeed.queryPage({
    projectId: h.projectId,
    workId: workId as WorkId,
    userId: h.userId,
    after: null,
    limit: 50,
  });
  expect(page.map((item) => item.id).sort()).toEqual([memberA, memberB].sort());

  const first = await h.repos.workChatFeed.queryPage({
    projectId: h.projectId,
    workId: workId as WorkId,
    userId: h.userId,
    after: null,
    limit: 1,
  });
  expect(first).toHaveLength(1);
  const only = first[0];
  if (!only) throw new Error("Expected one Work-feed row");
  const rest = await h.repos.workChatFeed.queryPage({
    projectId: h.projectId,
    workId: workId as WorkId,
    userId: h.userId,
    after: { sortAt: only.lastActivityAt, threadId: only.id as ThreadId },
    limit: 50,
  });
  expect(rest.map((item) => item.id)).not.toContain(only.id);
  expect([only.id, ...rest.map((item) => item.id)].sort()).toEqual([memberA, memberB].sort());
}
