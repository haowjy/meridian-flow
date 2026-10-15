/** Send a new project chat in the current pane before background persistence. */
import type { AiWriteMode } from "@meridian/contracts/works";
import { useCallback, useState } from "react";
import { useThreadActions } from "@/client/stores";
import type { ComposerSubmitEnvelope } from "@/components/app/composer";
import type { CreationAgent, CreationChoices } from "@/features/agents/creation-agent";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useChatNavigation } from "@/features/project/routing/chat-navigation";
import { sendProjectChat } from "@/lib/send-project-chat";
import { useComposerSessionDraft } from "./useComposerSessionDraft";

export function useCreationComposer(projectId: string) {
  const { acceptCreatedChat } = useChatNavigation();
  const accountId = useAccountId();
  const draft = useComposerSessionDraft(accountId, { kind: "new-chat", id: projectId });
  const threadActions = useThreadActions();
  const [choices, setChoices] = useState<CreationChoices>({});
  const updateChoices = useCallback(
    (next: CreationChoices) => setChoices((current) => ({ ...current, ...next })),
    [],
  );

  return {
    choices,
    updateChoices,
    draft,
    submit(
      submission: ComposerSubmitEnvelope,
      context: {
        workId: string;
        workAiWriteMode: AiWriteMode;
        aiWriteMode?: AiWriteMode;
        agent: CreationAgent;
      },
    ) {
      return (
        sendProjectChat({
          accountId,
          projectId,
          text: submission.text,
          blocks: submission.blocks,
          references: submission.references,
          submissionId: submission.submissionId,
          draft: submission.draft,
          activatedSkillSlugs: submission.activatedSkillSlugs,
          agent: context.agent,
          workId: context.workId,
          workAiWriteMode: context.workAiWriteMode,
          ...(context.aiWriteMode ? { aiWriteMode: context.aiWriteMode } : {}),
          threadId: draft.chatId,
          threadActions,
          selectChat: (threadId) => {
            draft.handoff();
            acceptCreatedChat(threadId);
          },
        }) !== null
      );
    },
  };
}
