/** Same-tab in-flight project chat, keyed by thread id. Not full offline. */
import type { AgentSelection } from "@meridian/contracts/agents";

export type InflightChat = {
  threadId: string;
  projectId: string;
  title: string;
  text: string;
  workId: string | null;
  agentSelection: AgentSelection;
  agentName: string;
  agentSlug: string;
  optimisticUserTurnId: string;
  workingTurnId: string;
  submissionId: string;
  activatedSkillSlugs?: string[];
};

const key = (threadId: string) => `meridian-inflight-chat:${threadId}`;
const persistJobs = new Map<string, Promise<void>>();

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function writeInflightChat(record: InflightChat): void {
  storage()?.setItem(key(record.threadId), JSON.stringify(record));
}

export function readInflightChat(threadId: string): InflightChat | null {
  const raw = storage()?.getItem(key(threadId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as InflightChat;
    if (
      value.threadId !== threadId ||
      typeof value.projectId !== "string" ||
      typeof value.title !== "string" ||
      typeof value.text !== "string" ||
      (value.workId !== null && typeof value.workId !== "string") ||
      typeof value.optimisticUserTurnId !== "string" ||
      typeof value.workingTurnId !== "string" ||
      typeof value.submissionId !== "string" ||
      typeof value.agentName !== "string" ||
      typeof value.agentSlug !== "string" ||
      typeof value.agentSelection?.catalogEntryId !== "string" ||
      typeof value.agentSelection?.definitionRevisionId !== "string"
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function clearInflightChat(threadId: string): void {
  storage()?.removeItem(key(threadId));
}

export function runExclusivePersist(threadId: string, job: () => Promise<void>): Promise<void> {
  const existing = persistJobs.get(threadId);
  if (existing) return existing;
  const running = job().finally(() => persistJobs.delete(threadId));
  persistJobs.set(threadId, running);
  return running;
}
