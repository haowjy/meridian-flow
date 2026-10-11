/** Project first Send: mint ids, record the durable intent, select the current chat, persist in the background. */
import type { SubmittedReference, UserMessageBlock } from "@meridian/contracts/protocol";
import { type ChatSubmission, recordChatSubmission } from "@/client/chat-submissions";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerDraftSnapshot } from "@/components/app/composer/composer-document";
import type { CreationAgent } from "@/features/agents/creation-agent";
import { makeOptimisticThread } from "./optimistic-thread";
import { deriveTitleFromMessage } from "./thread-title";

export type SendProjectChatArgs = {
  accountId: string;
  projectId: string;
  /** The composer's message as submitted; `text` is its blocks' text, not trimmed. */
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  submissionId: string;
  draft?: ComposerDraftSnapshot;
  activatedSkillSlugs?: readonly string[];
  agent: CreationAgent;
  workId: string;
  threadActions: ThreadStoreActions;
  selectChat: (threadId: string) => void;
  rememberRow: (recordId: string, threadId: string, turnId: string) => void;
  now?: number;
};

export type SendProjectChatResult = {
  threadId: string;
  optimisticUserTurnId: string;
};

export function sendProjectChat({
  accountId,
  projectId,
  text,
  blocks,
  references,
  submissionId,
  draft,
  activatedSkillSlugs,
  agent,
  workId,
  threadActions,
  selectChat,
  rememberRow,
  now,
}: SendProjectChatArgs): SendProjectChatResult | null {
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const title = deriveTitleFromMessage(text.trim());

  {
    // Durable witness before any display or navigation: if the intent cannot be
    // persisted, do not show a destination or dispatch it. Keep the draft so
    // the composer can report the local failure.
    const submission: ChatSubmission = {
      recordId: submissionId,
      submissionId,
      threadId,
      projectId,
      createdAt: timestamp,
      text,
      blocks: [...blocks],
      references: [...references],
      activatedSkillSlugs: activatedSkillSlugs ? [...activatedSkillSlugs] : [],
      draft,
      creation: {
        title,
        workId,
        agentSelection: agent.selection,
        agentName: agent.name,
        agentSlug: agent.slug,
      },
    };
    if (!recordChatSubmission(accountId, submission)) return null;
    threadActions.ensureThread(
      makeOptimisticThread({ id: threadId, projectId, title, timestamp, workId, agent }),
    );
  }

  const optimisticUserTurnId = threadActions.appendUserTurn(threadId, blocks).id;
  rememberRow(submissionId, threadId, optimisticUserTurnId);
  selectChat(threadId);
  // Mounting the selected destination wakes its submission driver.
  return { threadId, optimisticUserTurnId };
}
