import { Trans } from "@lingui/react/macro";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { useStartIndependentChat } from "@/features/chat/useStartIndependentChat";
import { HomeColumn } from "@/features/home/HomeColumn";
import { HomeHero } from "@/features/home/HomeHero";
import { PackageShowcase } from "@/features/home/PackageShowcase";
import { RecentProjects } from "@/features/home/RecentProjects";

/**
 * Authenticated Home: composer + recent projects + first-party package cards.
 * Submitting reserves a durable creation attempt before requesting a project.
 * A secondary action starts an independent (project-less) chat instead.
 */
export function HomeView() {
  const startIndependentChat = useStartIndependentChat();

  return (
    <HomeColumn>
      <HomeHero />

      <div className="mt-6">
        <CreationComposer projectId={null} autoFocus />
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
