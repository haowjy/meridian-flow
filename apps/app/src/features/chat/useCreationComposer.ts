/** Send a new project chat in the current pane before background persistence. */
import { useState } from "react";
import { useThreadActions } from "@/client/stores";
import type { ComposerDraftChange, ComposerSubmitEnvelope } from "@/components/app/composer";
import type { CreationAgent, CreationChoices } from "@/features/agents/creation-agent";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useChatNavigation } from "@/features/project/routing/chat-navigation";
import { sendProjectChat } from "@/lib/send-project-chat";

export function useCreationComposer(projectId: string) {
  const { acceptCreatedChat } = useChatNavigation();
  const accountId = useAccountId();
  const threadActions = useThreadActions();
  const [choices, setChoices] = useState<CreationChoices>({});

  return {
    choices,
    updateChoices: (next: CreationChoices) => setChoices((current) => ({ ...current, ...next })),
    updateDraft: (_change: ComposerDraftChange) => undefined,
    submit(
      submission: ComposerSubmitEnvelope,
      context: { workId: string | null; agent: CreationAgent },
    ) {
      return (
        sendProjectChat({
          accountId,
          projectId,
          text: submission.text,
          submissionId: submission.submissionId,
          activatedSkillSlugs: submission.activatedSkillSlugs,
          agent: context.agent,
          workId: context.workId,
          threadActions,
          selectChat: acceptCreatedChat,
        }) !== null
      );
    },
  };
}
