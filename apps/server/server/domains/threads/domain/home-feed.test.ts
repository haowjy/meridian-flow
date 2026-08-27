/** Behavior coverage for Home feed pagination, lineage, and writer state. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { getHomeChatFeedPage, InvalidHomeFeedCursorError } from "./home-feed.js";
import { encodeProjectChatCursor } from "./project-chat-cursor.js";

const USER_ID = "00000000-0000-4000-8000-000000000101";
const PROJECT_ID = "00000000-0000-4000-8000-000000000102";

describe("Home chat feed", () => {
  it("rejects PostgreSQL-incompatible timestamps before repository access", async () => {
    const queryPage = vi.fn();
    await expect(
      getHomeChatFeedPage({
        repository: { queryPage },
        projectId: PROJECT_ID,
        userId: USER_ID,
        cursor: encodeProjectChatCursor({
          sortAt: "0000-01-01T00:00:00.000000Z",
          threadId: "00000000-0000-4000-8000-000000000103",
        }),
      }),
    ).rejects.toBeInstanceOf(InvalidHomeFeedCursorError);
    expect(queryPage).not.toHaveBeenCalled();
  });

  it("partitions Continue, favorites, and stable Recent pages without duplicates", async () => {
    const repos = createInMemoryRepositories();
    const ids: string[] = [];
    for (let index = 0; index < 28; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`;
      ids.push(id);
      await repos.threads.create({
        id,
        projectId: PROJECT_ID,
        userId: USER_ID,
        title: `Chat ${index}`,
      });
      await repos.turns.create({
        id: `10000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
        threadId: id,
        role: "user",
        status: "complete",
        createdAt: "2026-08-13T20:01:02.123Z",
      });
    }
    const favoriteId = ids[26];
    if (!favoriteId) throw new Error("missing favorite fixture");
    await repos.threadUserState.update({
      threadId: favoriteId,
      userId: USER_ID,
      isFavorite: true,
    });
    const first = await getHomeChatFeedPage({
      repository: repos.homeFeed,
      projectId: PROJECT_ID,
      userId: USER_ID,
    });
    expect(first.featured?.continueChat?.id).toBe(ids[27]);
    expect(first.featured?.favoriteChats.map(({ id }) => id)).toEqual([ids[26]]);
    expect(first.recentChats.items).toHaveLength(24);
    const second = await getHomeChatFeedPage({
      repository: repos.homeFeed,
      projectId: PROJECT_ID,
      userId: USER_ID,
      cursor: first.recentChats.nextCursor,
    });
    expect(second.featured).toBeNull();
    expect(second.recentChats.items).toHaveLength(2);
    const allIds = [
      first.featured?.continueChat?.id,
      ...(first.featured?.favoriteChats.map(({ id }) => id) ?? []),
      ...first.recentChats.items.map(({ id }) => id),
      ...second.recentChats.items.map(({ id }) => id),
    ];
    expect(new Set(allIds).size).toBe(28);
  });

  it("skips metadata-only tails and preserves action-required precedence", async () => {
    const repos = createInMemoryRepositories();
    const threadId = "00000000-0000-4000-8000-000000000301";
    const userTurnId = "00000000-0000-4000-8000-000000000302";
    const assistantTurnId = "00000000-0000-4000-8000-000000000303";
    await repos.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      userId: USER_ID,
      title: "Story",
    });
    await repos.turns.create({
      id: userTurnId,
      threadId,
      role: "user",
      status: "complete",
      createdAt: "2026-08-13T10:00:00.000Z",
    });
    await repos.turns.create({
      id: assistantTurnId,
      threadId,
      prevTurnId: userTurnId,
      role: "assistant",
      status: "waiting_interrupt",
      createdAt: "2026-08-13T10:01:00.000Z",
    });
    await repos.blocks.create({
      turnId: assistantTurnId,
      blockType: "text",
      sequence: 0,
      textContent: "  Answer\n\twith   normalized text  ",
    });
    await repos.turns.create({
      id: "00000000-0000-4000-8000-000000000304",
      threadId,
      prevTurnId: assistantTurnId,
      role: "user",
      status: "complete",
      createdAt: "2026-08-13T11:00:00.000Z",
      metadata: { kind: "system_update", section: "work_context" },
    });
    const page = await getHomeChatFeedPage({
      repository: repos.homeFeed,
      projectId: PROJECT_ID,
      userId: USER_ID,
    });
    expect(page.featured?.continueChat).toMatchObject({
      lastActivityAt: "2026-08-13T10:01:00.000000Z",
      lastMessagePreview: "Answer with normalized text",
      actionRequired: true,
    });
  });
});
