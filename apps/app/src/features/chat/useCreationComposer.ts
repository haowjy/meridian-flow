import type { ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useCallback, useState } from "react";
import { useAccountId } from "@/client/account/account-context";
import type { ComposerSubmitEnvelope } from "@/client/chat-submissions/composer-document";
import { useThreadActions } from "@/client/stores";
import type { CreationAgent, CreationChoices } from "@/features/agents/creation-agent";
import { sendProjectChat } from "@/features/chat/send-project-chat";
import { usePanePlace } from "@/features/project/pane-place";
import { useChatNavigation } from "@/features/project/routing/chat-navigation";
import { useComposerSessionDraft } from "./useComposerSessionDraft";

export function useCreationComposer(projectId: string) {
  const { acceptCreatedChat } = useChatNavigation();
  const accountId = useAccountId();
  const draftScope = {
    kind: usePanePlace() === "side" ? "side-new-chat" : "new-chat",
    id: projectId,
  } as const;
  const draft = useComposerSessionDraft(accountId, draftScope);
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
        workDraftId: string | null;
        aiWriteMode?: AiWriteMode;
        agent: CreationAgent;
        overrides: ThreadOverrides;
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
          overrides: context.overrides,
          workId: context.workId,
          workAiWriteMode: context.workAiWriteMode,
          workDraftId: context.workDraftId,
          ...(context.aiWriteMode ? { aiWriteMode: context.aiWriteMode } : {}),
          threadId: draft.chatId,
          draftScope,
          threadActions,
          selectChat: (threadId) => {
            draft.handoffCreated(threadId);
            acceptCreatedChat(threadId);
          },
        }) !== null
      );
    },
  };
}
