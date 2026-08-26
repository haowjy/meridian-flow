/** Conformance coverage for the real in-memory Work chat feed adapter. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

const USER_ID = "00000000-0000-4000-8000-000000000101";
const PROJECT_ID = "00000000-0000-4000-8000-000000000102";
const WORK_ID = "00000000-0000-4000-8000-000000000103";
const LOWER_THREAD_ID = "00000000-0000-4000-8000-000000000201";
const HIGHER_THREAD_ID = "00000000-0000-4000-8000-000000000202";

afterEach(() => vi.useRealTimers());

describe("in-memory Work chat feed adapter", () => {
  it("preserves concurrent favorite and open-acknowledgement updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T20:01:02.123Z"));
    const repositories = createInMemoryRepositories();

    const [favorite, acknowledgement] = await Promise.all([
      repositories.threadUserState.update({
        threadId: HIGHER_THREAD_ID,
        userId: USER_ID,
        isFavorite: true,
      }),
      repositories.threadUserState.update({
        threadId: HIGHER_THREAD_ID,
        userId: USER_ID,
        acknowledgeOpen: true,
      }),
    ]);

    expect(favorite.isFavorite).toBe(true);
    expect(acknowledgement).toMatchObject({
      isFavorite: true,
      lastOpenedAt: "2026-08-13T20:01:02.123Z",
    });
    await expect(repositories.threadUserState.get(HIGHER_THREAD_ID, USER_ID)).resolves.toEqual({
      isFavorite: true,
      lastOpenedAt: "2026-08-13T20:01:02.123Z",
    });
  });

  it("pages equal timestamps by descending thread ID using its emitted exact cursor key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T20:01:02.123Z"));
    const repositories = createInMemoryRepositories();
    for (const threadId of [LOWER_THREAD_ID, HIGHER_THREAD_ID]) {
      await repositories.threads.create({
        id: threadId,
        projectId: PROJECT_ID,
        userId: USER_ID,
        title: threadId,
      });
      await repositories.threadWorks.addMembership(threadId, WORK_ID, true);
    }

    const first = await repositories.workChatFeed.queryPage({
      projectId: PROJECT_ID,
      workId: WORK_ID,
      userId: USER_ID,
      after: null,
      limit: 1,
    });
    expect(first).toMatchObject([
      { item: { id: HIGHER_THREAD_ID }, updatedAt: "2026-08-13T20:01:02.123000Z" },
    ]);

    const firstRow = first[0];
    if (!firstRow) throw new Error("missing first Work feed row");
    const second = await repositories.workChatFeed.queryPage({
      projectId: PROJECT_ID,
      workId: WORK_ID,
      userId: USER_ID,
      after: { sortAt: firstRow.updatedAt, threadId: firstRow.item.id },
      limit: 1,
    });
    expect(second).toMatchObject([
      { item: { id: LOWER_THREAD_ID }, updatedAt: "2026-08-13T20:01:02.123000Z" },
    ]);
  });

  it("excludes threads whose project is invisible", async () => {
    const repositories = createInMemoryRepositories({
      projects: {
        findById: async () => ({ deletedAt: "2026-08-13T20:01:02.123Z" }),
      },
    });
    await repositories.threads.create({
      id: HIGHER_THREAD_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      title: "Invisible project chat",
    });
    await repositories.threadWorks.addMembership(HIGHER_THREAD_ID, WORK_ID, true);

    await expect(
      repositories.workChatFeed.queryPage({
        projectId: PROJECT_ID,
        workId: WORK_ID,
        userId: USER_ID,
        after: null,
        limit: 50,
      }),
    ).resolves.toEqual([]);
  });
});
