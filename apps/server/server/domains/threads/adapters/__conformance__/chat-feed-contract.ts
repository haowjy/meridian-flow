/** PostgreSQL chat-feed contracts for literal search and composed filter pagination. */
import type { ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { expect } from "vitest";
import type { ThreadRepositories } from "../../ports/repositories.js";

export type ChatFeedConformanceHarness = {
  repos: Pick<ThreadRepositories, "threads" | "threadUserState" | "threadWorks" | "chatFeed">;
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
    workId: null,
  });
  return page.map((item) => item.id);
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
    workId: null,
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
    workId: null,
  });
  expect(secondPage.map((item) => item.id)).toEqual(expectedOrder.slice(2));
}

/** Work membership composes with the Project feed's search, favorite, and cursor filters. */
export async function expectChatFeedWorkFilterContract(
  h: ChatFeedConformanceHarness,
): Promise<void> {
  const inWorkFavorite = "00000000-0000-4000-8000-00000000f001";
  const inWorkOther = "00000000-0000-4000-8000-00000000f002";
  const inOtherWork = "00000000-0000-4000-8000-00000000f003";
  const archivedMember = "00000000-0000-4000-8000-00000000f004";
  await createTitledThread(h, inWorkFavorite, "Sect favorite");
  await createTitledThread(h, inWorkOther, "Sect other");
  await createTitledThread(h, inOtherWork, "Sect other Work");
  await createTitledThread(h, archivedMember, "Archived Work chat");
  await h.repos.threads.updateStatus(archivedMember as ThreadId, "archived");
  const workId = await h.createWork();
  const otherWorkId = await h.createWork();
  await h.repos.threadWorks.addMembership(inWorkFavorite as ThreadId, workId as WorkId, true);
  await h.repos.threadWorks.addMembership(inWorkOther as ThreadId, workId as WorkId, true);
  await h.repos.threadWorks.addMembership(inOtherWork as ThreadId, otherWorkId as WorkId, true);
  await h.repos.threadWorks.addMembership(archivedMember as ThreadId, workId as WorkId, true);
  await h.repos.threadUserState.update({
    threadId: inWorkFavorite as ThreadId,
    userId: h.userId as UserId,
    isFavorite: true,
  });
  await h.repos.threadUserState.update({
    threadId: inOtherWork as ThreadId,
    userId: h.userId as UserId,
    isFavorite: true,
  });

  const page = (options: { favorite?: boolean; search?: string | null } = {}) =>
    h.repos.chatFeed.queryPage({
      projectId: h.projectId,
      userId: h.userId,
      after: null,
      limit: 50,
      favorite: options.favorite ?? false,
      search: options.search ?? null,
      workId: workId as WorkId,
    });
  expect((await page()).map((item) => item.id).sort()).toEqual(
    [inWorkFavorite, inWorkOther].sort(),
  );
  expect((await page({ favorite: true, search: "sect" })).map((item) => item.id)).toEqual([
    inWorkFavorite,
  ]);

  const first = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: null,
    limit: 1,
    favorite: true,
    search: "sect",
    workId: workId as WorkId,
  });
  const firstItem = first[0];
  if (!firstItem) throw new Error("Expected one Work-filtered favorite");
  const rest = await h.repos.chatFeed.queryPage({
    projectId: h.projectId,
    userId: h.userId,
    after: { sortAt: firstItem.lastActivityAt, threadId: firstItem.id as ThreadId },
    limit: 50,
    favorite: true,
    search: "sect",
    workId: workId as WorkId,
  });
  expect([...first, ...rest].map((item) => item.id)).toEqual([inWorkFavorite]);
}
