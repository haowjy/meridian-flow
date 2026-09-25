/** Project chat index and server-filtered Favorites. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useEffect, useState } from "react";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useAnnouncement } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { useOpenNewChatRoute } from "../routing/ProjectNavigationContext";
import { ProjectFeed } from "./ProjectFeed";

export type ChatLandingScreenProps = {
  projectId: string;
  onOpenThread: (threadId: string) => void;
};

export function ChatLandingScreen({ projectId, onOpenThread }: ChatLandingScreenProps) {
  const [favorite, setFavorite] = useState(false);
  const feed = useProjectChatFeed(projectId, favorite);
  const openNewChat = useOpenNewChatRoute();
  const { announce, announceError } = useAnnouncement();

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rowProps = {
    now,
    onOpen: (item: ProjectChatItem) => onOpenThread(item.id),
    onFavorite: (item: ProjectChatItem, value: boolean) => {
      void feed.setFavorite(item.id, value).then((saved) => {
        if (saved)
          announce(
            value ? t`${item.title} added to Favorites` : t`${item.title} removed from Favorites`,
          );
        else announceError(t`Favorite wasn’t saved`);
      });
    },
  };

  return (
    <div data-chat-landing-scroll-owner className="app-scroll main-pane">
      <div className="project-screen-column">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <h1 className="text-headline-section">
              <Trans>Chats</Trans>
            </h1>
            <Button variant="ghost" onClick={() => setFavorite(false)} aria-pressed={!favorite}>
              <Trans>All</Trans>
            </Button>
            <Button variant="ghost" onClick={() => setFavorite(true)} aria-pressed={favorite}>
              <Trans>Favorites</Trans>
            </Button>
            <Button onClick={() => void openNewChat?.()}>
              <Trans>New chat</Trans>
            </Button>
          </div>
          <ProjectFeed projectId={projectId} feed={feed} rowProps={rowProps} />
        </div>
      </div>
    </div>
  );
}
