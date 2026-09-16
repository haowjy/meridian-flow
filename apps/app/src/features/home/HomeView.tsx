import { Trans } from "@lingui/react/macro";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { useStartIndependentChat } from "@/features/chat/useStartIndependentChat";
import { HomeColumn } from "@/features/home/HomeColumn";
import { HomeHero } from "@/features/home/HomeHero";
import { RecentProjects } from "@/features/home/RecentProjects";

/**
 * Authenticated Home: composer + recent projects.
 * Submitting creates a project then opens its chat.
 * A secondary action starts an independent (project-less) chat instead.
 */
export function HomeView() {
  const independentChat = useStartIndependentChat();

  return (
    <HomeColumn>
      <HomeHero />

      <div className="mt-6">
        <CreationComposer projectId={null} autoFocus />
      </div>

      <div className="mt-2 flex justify-center">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={!independentChat.ready}
          onClick={() => independentChat.start()}
        >
          <MessageSquarePlus className="size-4" aria-hidden />
          <Trans>Start a quick chat without a project</Trans>
        </Button>
      </div>

      <RecentProjects />
    </HomeColumn>
  );
}
