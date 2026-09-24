/** Project Home Send: mint ids, record the durable intent, replace the URL, persist in the background. */
import type { Thread } from "@meridian/contracts/protocol";
import {
  type FirstSendChatSubmission,
  recordChatSubmission,
  retireChatSubmission,
} from "@/client/chat-submissions";
import type { PendingStreamStart, ThreadStoreActions } from "@/client/stores";
import { isSettingsSection } from "@/features/account/settings-sections";
import type { CreationAgent } from "@/features/agents/creation-agent";
import { projectAddressHref } from "@/features/project/routing/project-address";
import { deriveTitleFromMessage } from "./thread-title";

const OPTIMISTIC_OWNER_ID = "optimistic-local";

const persistJobs = new WeakMap<AbortSignal, Map<string, Promise<Thread>>>();

/**
 * Per-tab session ids for an in-flight first send. A remount before
 * acknowledgement must reuse the destination rows instead of appending a
 * second pending user turn and working turn. Keyed `accountId:submissionId`.
 */
const firstSendSessionIds = new Map<
  string,
  { optimisticUserTurnId: string; workingTurnId: string }
>();

/** Share only create-or-get across mounts in one account epoch; each mount owns dispatch. */
export function runExclusiveThreadCreation(
  accountEpoch: AbortSignal,
  threadId: string,
  create: () => Promise<Thread>,
): Promise<Thread> {
  let jobs = persistJobs.get(accountEpoch);
  if (!jobs) {
    jobs = new Map();
    persistJobs.set(accountEpoch, jobs);
  }
  const existing = jobs.get(threadId);
  if (existing) return existing;
  const running = create().finally(() => jobs.delete(threadId));
  jobs.set(threadId, running);
  return running;
}

export type SendProjectChatArgs = {
  accountId: string;
  threadId?: string;
  projectId: string;
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

export type SendProjectChatResult = {
  threadId: string;
  optimisticUserTurnId: string;
  workingTurnId: string;
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

export function inflightChatHref(projectId: string, threadId: string, search = ""): string {
  const settings = new URLSearchParams(search).get("settings");
  return projectAddressHref({
    projectId,
    destination: { kind: "chat", chatId: threadId },
    chat: { kind: "absent" },
    work: { kind: "absent" },
    results: false,
    ...(isSettingsSection(settings) ? { settings } : {}),
  });
}

export function sendProjectChat({
  accountId,
  threadId: existingThreadId,
  projectId,
  text,
  submissionId,
  activatedSkillSlugs,
  agent,
  workId,
  threadActions,
  replace,
  search = "",
  now,
}: SendProjectChatArgs): SendProjectChatResult | null {
  const threadId = existingThreadId ?? crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const trimmed = text.trim();
  const title = deriveTitleFromMessage(trimmed);
  const isNew = !existingThreadId;

  if (isNew) {
    // Durable witness before any display or navigation: if the intent cannot be
    // persisted, do not show a destination or dispatch it. Keep the draft so
    // the composer can report the local failure.
    const submission: FirstSendChatSubmission = {
      kind: "first-send",
      submissionId,
      threadId,
      projectId,
      createdAt: timestamp,
      text: trimmed,
      activatedSkillSlugs: activatedSkillSlugs ? [...activatedSkillSlugs] : [],
      title,
      workId,
      agentSelection: agent.selection,
      agentName: agent.name,
      agentSlug: agent.slug,
    };
    if (!recordChatSubmission(accountId, submission)) return null;
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
  firstSendSessionIds.set(`${accountId}:${submissionId}`, {
    optimisticUserTurnId,
    workingTurnId,
  });
  replace(inflightChatHref(projectId, threadId, search));
  return { threadId, optimisticUserTurnId, workingTurnId };
}

/** Retire the durable first-send intent on acknowledgement or a definitive outcome. */
export function retireFirstSendSubmission(
  accountId: string,
  submissionId: string,
  threadId: string,
  threadActions: ThreadStoreActions,
  expectedEpoch?: number,
): void {
  retireChatSubmission(accountId, submissionId, expectedEpoch);
  firstSendSessionIds.delete(`${accountId}:${submissionId}`);
  threadActions.clearPendingCreation({ threadId });
}

/**
 * Rebuild the destination rows from a durable first-send intent, then return
 * the `persistCreation` inputs. Used when the in-memory pending stream and the
 * same-tab sessionStorage handoff are both gone.
 */
export function rehydrateFirstSendSubmission(
  entry: FirstSendChatSubmission,
  threadActions: ThreadStoreActions,
  accountId: string,
): NonNullable<PendingStreamStart["creation"]> {
  threadActions.ensureThread(
    makeOptimisticThread({
      id: entry.threadId,
      projectId: entry.projectId,
      title: entry.title,
      timestamp: entry.createdAt,
      workId: entry.workId,
      agent: {
        name: entry.agentName,
        slug: entry.agentSlug,
        selection: entry.agentSelection,
      },
    }),
  );
  threadActions.markPendingCreation({ threadId: entry.threadId });
  threadActions.markHandoffPending(entry.threadId);
  // Reuse the rows a same-tab remount already appended before acknowledgement;
  // only a fresh store (real reload or another tab) needs new local ids.
  const mapKey = `${accountId}:${entry.submissionId}`;
  const remembered = firstSendSessionIds.get(mapKey);
  const existingTurns = threadActions.turns(entry.threadId) ?? [];
  const reuse =
    remembered !== undefined &&
    existingTurns.some((turn) => turn.id === remembered.optimisticUserTurnId);
  const optimisticUserTurnId = reuse
    ? remembered.optimisticUserTurnId
    : threadActions.appendUserTurn(entry.threadId, entry.text).id;
  const workingTurnId = reuse ? remembered.workingTurnId : crypto.randomUUID();
  threadActions.ensureAssistantTurn(entry.threadId, workingTurnId);
  firstSendSessionIds.set(mapKey, { optimisticUserTurnId, workingTurnId });
  return {
    projectId: entry.projectId,
    title: entry.title,
    text: entry.text,
    agentSelection: entry.agentSelection,
    workId: entry.workId,
    optimisticUserTurnId,
    workingTurnId,
    submissionId: entry.submissionId,
    activatedSkillSlugs: entry.activatedSkillSlugs,
    createProject: false,
  };
}
