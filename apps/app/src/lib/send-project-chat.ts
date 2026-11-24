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
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  submissionId: string;
  draft?: ComposerDraftSnapshot;
  activatedSkillSlugs?: readonly string[];
  agent: CreationAgent;
  overrides: ThreadOverrides;
  workId: string;
  workAiWriteMode: AiWriteMode;
  workDraftId: string | null;
  aiWriteMode?: AiWriteMode;
  threadId?: string;
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
    // keep: Record the durable submission before showing or navigating to the destination
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
  return { threadId };
}
