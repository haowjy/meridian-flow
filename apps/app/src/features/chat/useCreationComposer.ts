/** Prospective composer submit: project Home navigates first; account Home creates then navigates. */
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { createProject, createProjectThread } from "@/client/api/projects-api";
import { useThreadActions } from "@/client/stores";
import type { ComposerDraftChange, ComposerSubmitEnvelope } from "@/components/app/composer";
import type { CreationAgent, CreationChoices } from "@/features/agents/creation-agent";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { parseProjectAddress } from "@/features/project/routing/project-address";
import { sendProjectChat } from "@/lib/send-project-chat";
import { deriveTitleFromMessage } from "@/lib/thread-title";

export function useCreationComposer(projectId: string | null) {
  const router = useRouter();
  const accountId = useAccountId();
  const threadActions = useThreadActions();
  const [choices, setChoices] = useState<CreationChoices>({});
  const [busy, setBusy] = useState(false);

  return {
    choices,
    busy,
    submitLocked: busy,
    contextLocked: busy,
    updateChoices: (next: CreationChoices) => setChoices((current) => ({ ...current, ...next })),
    updateDraft: (_change: ComposerDraftChange) => undefined,
    async submit(
      submission: ComposerSubmitEnvelope,
      context: { workId: string | null; agent: CreationAgent },
    ) {
      if (busy) return false;
      if (projectId) {
        const parsed = parseProjectAddress(
          router.history.location.pathname,
          router.history.location.search,
          router.history.location.state,
        );
        if (parsed.kind !== "valid") return false;
        sendProjectChat({
          accountId,
          projectId,
          projectSlug: parsed.address.projectSlug,
          text: submission.text,
          submissionId: submission.submissionId,
          activatedSkillSlugs: submission.activatedSkillSlugs,
          agent: context.agent,
          workId: context.workId,
          threadActions,
          search: router.history.location.search,
          replace: (href) => router.history.replace(href),
        });
        return true;
      }
      setBusy(true);
      try {
        const createdProject = await createProject({
          id: crypto.randomUUID(),
          title: deriveTitleFromMessage(submission.text),
        });
        const thread = await createProjectThread(createdProject.id, {
          id: crypto.randomUUID(),
          title: deriveTitleFromMessage(submission.text),
          workId: context.workId,
          agentSelection: context.agent.selection,
        });
        await router.navigate({
          href: `/p/${createdProject.slug}/chat/${thread.id}`,
          replace: true,
        });
        return true;
      } finally {
        setBusy(false);
      }
    },
  };
}
