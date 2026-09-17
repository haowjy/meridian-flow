/** Project Home Send: mint ids, write local, replace the URL, persist in the background. */
import type { Thread } from "@meridian/contracts/protocol";
import type { ThreadStoreActions } from "@/client/stores";
import { isSettingsSection } from "@/features/account/settings-sections";
import type { CreationAgent } from "@/features/agents/creation-agent";
import { projectAddressHref } from "@/features/project/routing/project-address";
import {
  clearInflightChat,
  type InflightChat,
  readInflightChat,
  writeInflightChat,
} from "./inflight-chat";
import { deriveTitleFromMessage } from "./thread-title";

const OPTIMISTIC_OWNER_ID = "optimistic-local";

export type SendProjectChatArgs = {
  threadId?: string;
  projectId: string;
  projectSlug: string;
  text: string;
  submissionId: string;
  activatedSkillSlugs?: readonly string[];
  agent: CreationAgent;
  workId: string | null;
  threadActions: ThreadStoreActions;
  replace: (href: string) => void;
  search?: string;
  now?: number;
};

export function makeOptimisticThread(input: {
  id: string;
  projectId: string;
  title: string;
  timestamp: string;
  workId?: string | null;
  agent?: CreationAgent;
}): Thread {
  return {
    id: input.id,
    projectId: input.projectId,
    workId: input.workId ?? null,
    userId: OPTIMISTIC_OWNER_ID,
    kind: "primary",
    status: "idle",
    title: input.title,
    ref: null,
    agentDefinitionRevisionId: input.agent?.selection.definitionRevisionId ?? null,
    agentName: input.agent?.name ?? null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: input.id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    deletedAt: null,
  };
}

export function inflightChatHref(projectSlug: string, threadId: string, search = ""): string {
  const settings = new URLSearchParams(search).get("settings");
  return projectAddressHref({
    projectSlug,
    destination: { kind: "chat", chatId: threadId },
    chat: { kind: "absent" },
    work: { kind: "absent" },
    results: false,
    ...(isSettingsSection(settings) ? { settings } : {}),
  });
}

export function sendProjectChat({
  threadId: existingThreadId,
  projectId,
  projectSlug,
  text,
  submissionId,
  activatedSkillSlugs,
  agent,
  workId,
  threadActions,
  replace,
  search = "",
  now,
}: SendProjectChatArgs): { threadId: string; optimisticUserTurnId: string; workingTurnId: string } {
  const threadId = existingThreadId ?? crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const trimmed = text.trim();
  const title = deriveTitleFromMessage(trimmed);
  const isNew = !existingThreadId;

  if (isNew) {
    threadActions.ensureThread(
      makeOptimisticThread({ id: threadId, projectId, title, timestamp, workId, agent }),
    );
    threadActions.markPendingCreation({ threadId });
  }

  threadActions.markHandoffPending(threadId);
  const optimisticUserTurnId = threadActions.appendUserTurn(threadId, trimmed).id;
  const workingTurnId = crypto.randomUUID();
  threadActions.ensureAssistantTurn(threadId, workingTurnId);

  if (!isNew) return { threadId, optimisticUserTurnId, workingTurnId };

  const inflight: InflightChat = {
    threadId,
    projectId,
    title,
    text: trimmed,
    workId,
    agentSelection: agent.selection,
    agentName: agent.name,
    agentSlug: agent.slug,
    optimisticUserTurnId,
    workingTurnId,
    submissionId,
    ...(activatedSkillSlugs?.length ? { activatedSkillSlugs: [...activatedSkillSlugs] } : {}),
  };
  writeInflightChat(inflight);
  threadActions.markPendingStream(threadId, {
    creation: {
      projectId,
      title,
      text: trimmed,
      agentSelection: agent.selection,
      workId,
      optimisticUserTurnId,
      workingTurnId,
      submissionId,
      ...(activatedSkillSlugs?.length ? { activatedSkillSlugs: [...activatedSkillSlugs] } : {}),
      createProject: false,
    },
  });
  replace(inflightChatHref(projectSlug, threadId, search));
  return { threadId, optimisticUserTurnId, workingTurnId };
}

export function finishInflightChat(threadId: string, threadActions: ThreadStoreActions): void {
  clearInflightChat(threadId);
  threadActions.clearPendingCreation({ threadId });
}

export function rehydrateInflightChat(
  threadId: string,
  threadActions: ThreadStoreActions,
): InflightChat | null {
  const inflight = readInflightChat(threadId);
  if (!inflight) return null;
  const existing = threadActions.turns(threadId);
  if (existing && existing.length > 0) return inflight;
  threadActions.ensureThread(
    makeOptimisticThread({
      id: threadId,
      projectId: inflight.projectId,
      title: inflight.title,
      timestamp: new Date().toISOString(),
      workId: inflight.workId,
      agent: {
        name: inflight.agentName,
        slug: inflight.agentSlug,
        selection: inflight.agentSelection,
      },
    }),
  );
  threadActions.markPendingCreation({ threadId });
  const optimisticUserTurnId = threadActions.appendUserTurn(threadId, inflight.text).id;
  const workingTurnId = crypto.randomUUID();
  threadActions.ensureAssistantTurn(threadId, workingTurnId);
  const next = { ...inflight, optimisticUserTurnId, workingTurnId };
  writeInflightChat(next);
  return next;
}
