/** Optimistic creation reserved for the out-of-scope standalone chat journey. */

import type { Project } from "@meridian/contracts/projects";
import type { Thread } from "@meridian/contracts/protocol";
import type { useNavigate } from "@tanstack/react-router";
import {
  markIndependentProject,
  type ProjectStoreActions,
  type ThreadStoreActions,
} from "@/client/stores";
import type { CreationAgent } from "@/features/agents/creation-agent";

import { deriveTitleFromMessage } from "./thread-title";

/** Placeholder owner for optimistic rows until the server response folds in. */
const OPTIMISTIC_OWNER_ID = "optimistic-local";

type NavigateFn = ReturnType<typeof useNavigate>;

export type StartIndependentChatArgs = {
  text?: string;
  agent: CreationAgent;
  projectActions: ProjectStoreActions;
  threadActions: ThreadStoreActions;
  navigate: NavigateFn;
  now?: number;
};

function makeOptimisticProject(id: string, title: string, timestamp: string): Project {
  return {
    id,
    userId: OPTIMISTIC_OWNER_ID,
    name: title,
    title,
    slug: id,
    isPersonal: false,
    systemPrompt: null,
    description: null,
    settings: {},
    lastActivityAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
}

function makeOptimisticThread(
  id: string,
  projectId: string,
  title: string,
  timestamp: string,
): Thread {
  return {
    id,
    projectId,
    workId: null,
    userId: OPTIMISTIC_OWNER_ID,
    kind: "primary",
    status: "idle",
    title,
    ref: null,
    currentAgent: null,
    agentDefinitionRevisionId: null,
    agentName: null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
}

/** Independent chats retain their existing UUID route and destination-owned creation. */
export function startIndependentChat({
  text,
  agent,
  projectActions,
  threadActions,
  navigate,
  now,
}: StartIndependentChatArgs): { projectId: string; threadId: string } {
  const projectId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const trimmed = text?.trim() ?? "";
  const title = deriveTitleFromMessage(trimmed);

  projectActions.ensureProject(makeOptimisticProject(projectId, title, timestamp));
  threadActions.ensureThread({
    ...makeOptimisticThread(threadId, projectId, title, timestamp),
    currentAgent: agent.slug,
    agentDefinitionRevisionId: agent.selection.definitionRevisionId,
    agentName: agent.name,
  });
  markIndependentProject(projectId);
  threadActions.markPendingCreation({ projectId, threadId });

  let optimisticUserTurnId: string | undefined;
  if (trimmed) {
    threadActions.markHandoffPending(threadId);
    optimisticUserTurnId = threadActions.appendUserTurn(threadId, trimmed).id;
  }
  threadActions.markPendingStream(threadId, {
    creation: {
      agentSelection: agent.selection,
      projectId,
      title,
      text: trimmed,
      createProject: true,
      ...(optimisticUserTurnId ? { optimisticUserTurnId } : {}),
    },
  });

  void navigate({ to: "/chat/$threadId", params: { threadId } });

  return { projectId, threadId };
}
