/** Focused in-memory adapter for Home/Work Project-chat projections and writer state. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, ProjectChatItem, Thread, Turn } from "@meridian/contracts/threads";
import {
  isThreadActionRequired,
  isVisibleConversationalTurn,
} from "../../domain/visible-conversation-policy.js";
import type {
  HomeChatFeedRepository,
  ThreadUserStateRepository,
  WorkChatFeedRepository,
} from "../../ports/repositories.js";

export type InMemoryThreadUserState = {
  isFavorite: boolean;
};

export interface InMemoryProjectChatSource {
  threads(): Iterable<Thread>;
  turn(id: string): Turn | undefined;
  blocks(): Iterable<Block>;
  isProjectVisible(thread: Thread): Promise<boolean>;
  primaryWorkId(threadId: ThreadId): string | null;
  hasWorkMembership(threadId: ThreadId, workId: string): boolean;
  work(id: string): Promise<{ id: string; name: string; deletedAt: string | null } | null>;
}

function exactTimestamp(value: string): string {
  return value.replace(
    /(?:\.(\d{1,6}))?Z$/,
    (_match, fraction = "") => `.${fraction.padEnd(6, "0")}Z`,
  );
}

export function createInMemoryProjectChatAdapter(
  source: InMemoryProjectChatSource,
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

  function actionRequired(head: Turn | null): boolean {
    return isThreadActionRequired({
      headRole: head?.role ?? null,
      headStatus: head?.status ?? null,
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
      actionRequired: actionRequired(head),
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
            item.lastActivityAt < input.after.sortAt ||
            (item.lastActivityAt === input.after.sortAt && item.id < input.after.threadId),
        )
        .slice(0, input.recentLimit);
      return { continueChat: input.includeFeatured ? continueChat : null, favorites, recent };
    },
  };

  const workChatFeed: WorkChatFeedRepository = {
    async queryPage(input) {
      const associated: Array<{ thread: Thread; updatedAt: string }> = [];
      for (const thread of source.threads()) {
        if (
          thread.projectId === input.projectId &&
          !thread.deletedAt &&
          source.hasWorkMembership(thread.id as ThreadId, input.workId) &&
          (await source.isProjectVisible(thread))
        ) {
          associated.push({ thread, updatedAt: exactTimestamp(thread.updatedAt) });
        }
      }
      return Promise.all(
        associated
          .filter(
            ({ thread, updatedAt }) =>
              !input.after ||
              updatedAt < input.after.sortAt ||
              (updatedAt === input.after.sortAt && thread.id < input.after.threadId),
          )
          .sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) || b.thread.id.localeCompare(a.thread.id),
          )
          .slice(0, input.limit)
          .map(async ({ thread, updatedAt }) => ({
            item: await projectChatItem(thread, input.userId),
            updatedAt,
          })),
      );
    },
  };

  const threadUserState: ThreadUserStateRepository = {
    async update(input) {
      const stateKey = key(input.threadId, input.userId);
      const next = { isFavorite: input.isFavorite };
      states.set(stateKey, next);
      return { threadId: input.threadId, ...next };
    },
  };

  return { homeFeed, workChatFeed, threadUserState, conversationalHead };
}
