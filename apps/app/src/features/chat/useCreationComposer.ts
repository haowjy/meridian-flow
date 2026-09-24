/** Send a new project chat from the Chat landing and navigate before persistence. */
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useThreadActions } from "@/client/stores";
import type { ComposerDraftChange, ComposerSubmitEnvelope } from "@/components/app/composer";
import type { CreationAgent, CreationChoices } from "@/features/agents/creation-agent";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { parseProjectAddress } from "@/features/project/routing/project-address";
import { sendProjectChat } from "@/lib/send-project-chat";

export function useCreationComposer(projectId: string) {
  const router = useRouter();
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
      const parsed = parseProjectAddress(
        router.history.location.pathname,
        router.history.location.search,
        router.history.location.state,
      );
      if (parsed.kind !== "valid") return false;
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
          search: router.history.location.search,
          replace: (href) => router.history.replace(href),
        }) !== null
      );
    },
  };
}
