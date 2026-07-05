import { Trans } from "@lingui/react/macro";
import { MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { ComposerAgentControl } from "@/features/agents/ComposerAgentControl";
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
          toolbarLeft={
            <ComposerAgentControl
              projectId={null}
              mode="interactive"
              selectedSlug={selectedAgentSlug}
              onSelectedSlugChange={setSelectedAgentSlug}
            />
          }
        />
      </div>

      <div className="mt-2 flex justify-center">
        <Button type="button" variant="quiet" size="sm" onClick={() => startIndependentChat()}>
          <MessageSquarePlus className="size-4" aria-hidden />
          <Trans>Start a quick chat without a project</Trans>
        </Button>
      </div>

      <RecentProjects />
      <PackageShowcase />
    </HomeColumn>
  );
}
