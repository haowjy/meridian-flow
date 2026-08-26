/** Focused Home/state fake over supplied in-memory conversation data. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  Block,
  ProjectChatAttention,
  ProjectChatItem,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import {
  isVisibleConversationalTurn,
  projectEffectiveThreadAttention,
} from "../../domain/visible-conversation-policy.js";
import type {
  HomeChatFeedRepository,
  ThreadUserStateRepository,
} from "../../ports/repositories.js";

export type InMemoryThreadUserState = {
  isFavorite: boolean;
  manuallyUnread: boolean;
  lastOpenedAt: string | null;
};

export interface InMemoryHomeStateSource {
  threads(): Iterable<Thread>;
  turn(id: string): Turn | undefined;
  blocks(): Iterable<Block>;
  isProjectVisible(thread: Thread): Promise<boolean>;
  primaryWorkId(threadId: ThreadId): string | null;
  work(id: string): Promise<{ id: string; name: string; deletedAt: string | null } | null>;
}

function exactTimestamp(value: string): string {
  return value.replace(/\.(\d{3})Z$/, ".$1000Z");
}

export function createInMemoryHomeStateAdapter(
  source: InMemoryHomeStateSource,
  states: Map<string, InMemoryThreadUserState>,
) {
  const key = (threadId: string, userId: string) => `${threadId}:${userId}`;

  function conversationalHead(thread: Thread): Turn | null {
    let turn = thread.activeLeafTurnId ? source.turn(thread.activeLeafTurnId) : undefined;
    const visited = new Set<string>();
    while (turn && !visited.has(turn.id)) {
      visited.add(turn.id);
      const hasCustomBlock = [...source.blocks()].some(
        (block) => block.turnId === turn?.id && block.blockType === "custom",
      );
      if (
        isVisibleConversationalTurn({
          role: turn.role,
          metadata: turn.metadata ?? null,
          hasCustomBlock,
        })
      ) {
        return turn;
      }
      turn = turn.parentTurnId ? source.turn(turn.parentTurnId) : undefined;
    }
    return null;
  }

  function effectiveAttention(
    thread: Thread,
    head: Turn | null,
    userId: string,
  ): ProjectChatAttention {
    const state = states.get(key(thread.id, userId));
    const activity = head ? (head.completedAt ?? head.createdAt) : thread.createdAt;
    return projectEffectiveThreadAttention({
      threadStatus: thread.status,
      headRole: head?.role ?? null,
      headStatus: head?.status ?? null,
      headActivityAt: activity,
      lastOpenedAt: state?.lastOpenedAt ?? null,
      manuallyUnread: state?.manuallyUnread ?? false,
    });
  }

  async function projectChatItem(thread: Thread, userId: string): Promise<ProjectChatItem> {
    const head = conversationalHead(thread);
    const workId = source.primaryWorkId(thread.id as ThreadId);
    const work = workId ? await source.work(workId) : null;
    const preview = head
      ? [...source.blocks()]
          .filter(
            (block) => block.turnId === head.id && block.blockType === "text" && !block.pruned,
          )
          .sort((a, b) => a.sequence - b.sequence)
          .map((block) => block.modelText ?? "")
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim()
      : "";
    const state = states.get(key(thread.id, userId));
    return {
      id: thread.id,
      title: thread.title ?? "",
      work: workId && work && !work.deletedAt ? { id: workId, title: work.name } : null,
      lastMessagePreview: preview ? Array.from(preview).slice(0, 240).join("") : null,
      lastActivityAt: exactTimestamp(
        head ? (head.completedAt ?? head.createdAt) : thread.createdAt,
      ),
      attention: effectiveAttention(thread, head, userId),
      isFavorite: state?.isFavorite ?? false,
    };
  }

  const homeFeed: HomeChatFeedRepository = {
    async queryPage(input) {
      const eligible: ProjectChatItem[] = [];
      for (const thread of source.threads()) {
        if (
          thread.projectId === input.projectId &&
          !thread.deletedAt &&
          thread.status !== "archived" &&
          (await source.isProjectVisible(thread))
        )
          eligible.push(await projectChatItem(thread, input.userId));
      }
      eligible.sort(
        (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id),
      );
      const continueChat = eligible[0] ?? null;
      const favorites = input.includeFeatured
        ? eligible.filter((item) => item.id !== continueChat?.id && item.isFavorite)
        : [];
      const recent = eligible
        .filter((item) => item.id !== continueChat?.id && !item.isFavorite)
        .filter(
          (item) =>
            !input.after ||
            item.lastActivityAt < input.after.lastActivityAt ||
            (item.lastActivityAt === input.after.lastActivityAt && item.id < input.after.threadId),
        )
        .slice(0, input.recentLimit);
      return { continueChat: input.includeFeatured ? continueChat : null, favorites, recent };
    },
  };

  const threadUserState: ThreadUserStateRepository = {
    async get(threadId, userId) {
      return (
        states.get(key(threadId, userId)) ?? {
          isFavorite: false,
          manuallyUnread: false,
          lastOpenedAt: null,
        }
      );
    },
    async effectiveAttention(threadId, userId) {
      const thread = [...source.threads()].find((candidate) => candidate.id === threadId);
      return thread ? effectiveAttention(thread, conversationalHead(thread), userId) : "none";
    },
    async update(input) {
      const current = await this.get(input.threadId, input.userId);
      const next = {
        isFavorite: input.isFavorite ?? current.isFavorite,
        manuallyUnread: input.isUnread ?? current.manuallyUnread,
        lastOpenedAt: input.isUnread === false ? new Date().toISOString() : current.lastOpenedAt,
      };
      states.set(key(input.threadId, input.userId), next);
      return {
        threadId: input.threadId,
        ...next,
        attention: await this.effectiveAttention(input.threadId, input.userId),
      };
    },
  };

  return { homeFeed, threadUserState, conversationalHead, projectChatItem };
}
