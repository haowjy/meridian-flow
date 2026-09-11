/** Creation UI observes the account owner and may replace only the entry that submitted. */

import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { CreationChoices } from "@/client/first-send-continuity";
import type { ComposerDraftChange, ComposerSubmitEnvelope } from "@/components/app/composer";
import { isSettingsSection } from "@/features/account/settings-sections";
import { projectAddressHref } from "@/features/project/routing/project-address";
import { deriveTitleFromMessage } from "@/lib/thread-title";
import { useCreation } from "./CreationProvider";

export function useCreationComposer(projectId: string | null) {
  const { controller, state } = useCreation(projectId);
  const router = useRouter();
  const revision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const stop = router.history.subscribe(() => {
      revision.current += 1;
    });
    return () => {
      mounted.current = false;
      revision.current += 1;
      stop();
    };
  }, [router]);
  function capture() {
    const entry = router.history.location;
    const expected = { revision: revision.current, href: entry.href, key: entry.state.__TSR_key };
    return () =>
      mounted.current &&
      expected.revision === revision.current &&
      expected.href === router.history.location.href &&
      expected.key === router.history.location.state.__TSR_key;
  }
  async function openCreated(isCurrent: () => boolean) {
    const attempt = controller.getSnapshot().slot?.attempt;
    if (!isCurrent() || attempt?.phase !== "ready" || !attempt.projectSlug || !attempt.threadSlug)
      return false;
    const settings = new URLSearchParams(router.history.location.search).get("settings");
    const href = projectAddressHref({
      projectSlug: attempt.projectSlug,
      destination: { kind: "chat", chatSlug: attempt.threadSlug },
      chat: { kind: "absent" },
      work: { kind: "absent" },
      results: false,
      ...(isSettingsSection(settings) ? { settings } : {}),
    });
    await router.navigate({ href, replace: true });
    if (router.history.location.href === href)
      await controller.acknowledgeNavigation(attempt.attemptId);
    return true;
  }
  return {
    state,
    busy: state.busy,
    submitLocked: !state.slot || state.busy || !!state.slot.attempt || !!state.issue,
    contextLocked: state.busy || (!!state.slot?.attempt && state.slot.attempt.phase !== "refused"),
    initialDraft: state.slot?.draft,
    loaded: state.slot !== null,
    updateChoices: (choices: CreationChoices) => controller.updateChoices(choices),
    updateDraft: (change: ComposerDraftChange) => controller.updateDraft(change.snapshot),
    reload: () => controller.reload(),
    startOver: () => controller.startOver(),
    discard: () => controller.updateDraft(null),
    async submit(
      submission: ComposerSubmitEnvelope,
      context: { workId: string | null; agentSlug: string },
    ) {
      const isCurrent = capture();
      const accepted = await controller.submit({
        submission,
        title: deriveTitleFromMessage(submission.text),
        ...context,
      });
      if (accepted) await openCreated(isCurrent);
      return accepted;
    },
    async createEmpty(title: string, agentSlug: string) {
      const isCurrent = capture();
      if (await controller.submit({ submission: null, title, workId: null, agentSlug }))
        await openCreated(isCurrent);
    },
    async retry(choices?: { workId: string | null; agentSlug: string }) {
      const isCurrent = capture();
      if (await controller.retry(choices)) await openCreated(isCurrent);
    },
  };
}
