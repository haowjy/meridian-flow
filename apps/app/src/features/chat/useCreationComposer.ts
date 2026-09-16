/** Project Home Send navigates first; account Home still creates then routes. */
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { createProject, createProjectThread } from "@/client/api/projects-api";
import { useThreadActions } from "@/client/stores";
import type { ComposerDraftChange, ComposerSubmitEnvelope } from "@/components/app/composer";
import type { CreationAgent, CreationChoices } from "@/features/agents/creation-agent";
import { parseProjectAddress } from "@/features/project/routing/project-address";
import { sendProjectChat } from "@/lib/send-project-chat";
import { deriveTitleFromMessage } from "@/lib/thread-title";

export function useCreationComposer(projectId: string | null) {
  const router = useRouter();
  const threadActions = useThreadActions();
  const [choices, setChoices] = useState<CreationChoices>({});
  const [busy, setBusy] = useState(false);

  return {
    state: { slot: { choices }, busy, issue: null as string | null, editorEpoch: 0 },
    busy,
    submitLocked: busy,
    contextLocked: busy,
    initialDraft: undefined,
    loaded: true,
    updateChoices: (next: CreationChoices) => setChoices((current) => ({ ...current, ...next })),
    updateDraft: (_change: ComposerDraftChange) => undefined,
    reload: () => undefined,
    startOver: () => undefined,
    discard: () => undefined,
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
          projectId,
          projectSlug: parsed.address.projectSlug,
          text: submission.text,
          submissionId: submission.submissionId,
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
    async createEmpty(title: string, agent: CreationAgent) {
      if (busy) return;
      setBusy(true);
      try {
        const createdProject = await createProject({ id: crypto.randomUUID(), title });
        const thread = await createProjectThread(createdProject.id, {
          id: crypto.randomUUID(),
          title,
          workId: null,
          agentSelection: agent.selection,
        });
        await router.navigate({
          href: `/p/${createdProject.slug}/chat/${thread.id}`,
          replace: true,
        });
      } finally {
        setBusy(false);
      }
    },
    async retry() {
      return false;
    },
  };
}
