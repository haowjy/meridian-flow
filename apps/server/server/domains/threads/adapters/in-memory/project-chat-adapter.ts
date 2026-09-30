/** Focused in-memory adapter for Project-chat projections and writer state. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, ProjectChatItem, Thread, Turn } from "@meridian/contracts/threads";
import {
  isThreadActionRequired,
  isVisibleConversationalTurn,
} from "../../domain/visible-conversation-policy.js";
import type {
  ProjectChatFeedRepository,
  ThreadUserStateRepository,
} from "../../ports/repositories.js";

// Match the database lineage cap and stop the nearest-assistant walk early.
const MAX_ACTIVE_LINEAGE_DEPTH = 10_000;

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

  function activeLineage(thread: Thread): Turn[] {
    const lineage: Turn[] = [];
    let turn = thread.activeLeafTurnId ? source.turn(thread.activeLeafTurnId) : undefined;
    while (turn && lineage.length <= MAX_ACTIVE_LINEAGE_DEPTH) {
      lineage.push(turn);
      if (turn.role === "assistant") break;
      turn = turn.parentTurnId ? source.turn(turn.parentTurnId) : undefined;
    }
    return lineage;
  }

  function conversationalHead(thread: Thread): Turn | null {
    for (const turn of activeLineage(thread)) {
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
    }
    return null;
  }

  function actionRequired(thread: Thread): boolean {
    return isThreadActionRequired({
      activeLineage: activeLineage(thread),
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
      agentName: thread.agentName,
      lastMessagePreview: preview ? Array.from(preview).slice(0, 240).join("") : null,
      lastActivityAt: exactTimestamp(
        head ? (head.completedAt ?? head.createdAt) : thread.createdAt,
      ),
      actionRequired: actionRequired(thread),
      isFavorite: state?.isFavorite ?? false,
    };
  }

  const chatFeed: ProjectChatFeedRepository = {
    async queryPage(input) {
      const eligible: ProjectChatItem[] = [];
      for (const thread of source.threads()) {
        if (
          thread.kind === "primary" &&
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
      return eligible
        .filter((item) => !input.favorite || item.isFavorite)
        .filter(
          (item) => !input.workId || source.hasWorkMembership(item.id as ThreadId, input.workId),
        )
        .filter(
          (item) => !input.search || item.title.toLowerCase().includes(input.search.toLowerCase()),
        )
        .filter(
          (item) =>
            !input.after ||
            item.lastActivityAt < input.after.sortAt ||
            (item.lastActivityAt === input.after.sortAt && item.id < input.after.threadId),
        )
        .slice(0, input.limit);
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

  return { chatFeed, threadUserState, actionRequired };
}
