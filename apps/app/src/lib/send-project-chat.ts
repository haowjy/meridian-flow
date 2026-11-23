/** Project first Send: mint ids, record the durable intent, select the current chat, persist in the background. */
import { newDraftId } from "@meridian/contracts";
import type { SubmittedReference, UserMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { NewChatSubmission } from "@/client/chat-submissions";
import { recordAndProjectSubmission } from "@/client/chat-submissions/owner";
import type { ComposerDraftScope } from "@/client/composer-drafts";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerDraftSnapshot } from "@/components/app/composer/composer-document";
import type { CreationAgent } from "@/features/agents/creation-agent";
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
  /** What this chat runs on instead of the Agent's, if the writer picked any. */
  overrides: ThreadOverrides;
  workId: string;
  /** The selected Work's default: the new chat's mode unless the writer chose one. */
  workAiWriteMode: AiWriteMode;
  /** The named Work's default draft, which the chat writes into; null under No Work, where it gets its own. */
  workDraftId: string | null;
  /** The writer's explicit choice in this composer; it becomes the Work's default too. */
  aiWriteMode?: AiWriteMode;
  /** The thread id minted before the first attach, which owns any uploads already attached. */
  threadId?: string;
  /** The draft the message was written in, handed to the journal once recorded. */
  draftScope: ComposerDraftScope;
  threadActions: ThreadStoreActions;
  selectChat: (threadId: string) => void;
  now?: number;
};

export type SendProjectChatResult = {
  threadId: string;
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
  overrides,
  workId,
  workAiWriteMode,
  workDraftId,
  aiWriteMode,
  threadId: mintedThreadId,
  draftScope,
  threadActions,
  selectChat,
  now,
}: SendProjectChatArgs): SendProjectChatResult | null {
  const threadId = mintedThreadId ?? crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const title = deriveTitleFromMessage(text.trim());

  {
    // Durable witness before any display or navigation: if the intent cannot be
    // persisted, do not show a destination or dispatch it. Keep the draft so
    // the composer can report the local failure.
    const submission: NewChatSubmission = {
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
        draftId: workDraftId ?? newDraftId(),
        workId,
        workAiWriteMode,
        ...(aiWriteMode ? { aiWriteMode } : {}),
        overrides,
        agentSelection: agent.selection,
        agentName: agent.name,
        agentSlug: agent.slug,
      },
    };
    if (!recordAndProjectSubmission(accountId, submission, threadActions, draftScope)) return null;
  }
  try {
    selectChat(threadId);
  } catch (error) {
    reportError(error);
  }
  // Mounting the selected destination wakes its submission driver.
  return { threadId };
}
