// @ts-nocheck
import { Trans } from "@lingui/react/macro";
import { MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { Composer } from "@/features/chat/Composer";
import { useComposerNewProject } from "@/features/chat/useComposerNewProject";
import { useStartIndependentChat } from "@/features/chat/useStartIndependentChat";
import { HomeColumn } from "@/features/home/HomeColumn";
import { HomeHero } from "@/features/home/HomeHero";
import { PackageShowcase } from "@/features/home/PackageShowcase";
import { RecentProjects } from "@/features/home/RecentProjects";

/**
 * Authenticated Home: composer + recent projects + first-party package cards.
 * Submitting the composer creates a project optimistically and navigates to it.
 * A secondary action starts an independent (project-less) chat instead.
 */
export function HomeView() {
  const handleSubmit = useComposerNewProject({ announceStarted: true });
  const startIndependentChat = useStartIndependentChat();
  const [selectedAgentSlug, setSelectedAgentSlug] = useState(DEFAULT_AGENT_SLUG);

  return (
    <HomeColumn>
      <HomeHero />

      <div className="mt-6">
        <Composer
          variant="hero"
          autoFocus
          onSubmit={(text) => handleSubmit(text, selectedAgentSlug)}
          agent={{
            projectId: null,
            mode: "interactive",
            selectedSlug: selectedAgentSlug,
            onSelectedSlugChange: setSelectedAgentSlug,
          }}
        />
      </div>

      <div className="mt-2 flex justify-center">
        <button
          type="button"
          onClick={() => startIndependentChat()}
          className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <MessageSquarePlus className="size-4" aria-hidden />
          <Trans>Start a quick chat without a project</Trans>
        </button>
      </div>

      <RecentProjects />
      <PackageShowcase />
    </HomeColumn>
  );
}
