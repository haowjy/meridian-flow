/** Composer-led Project Home and its independent, server-owned return feed. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useEffect, useState } from "react";
import { useHomeChatFeed } from "@/client/query/useHomeChatFeed";
import { useAnnouncement } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { useOpenNewChatRoute } from "../routing/ProjectNavigationContext";
import { HomeFeed } from "./HomeFeed";
import { useHomeFavoriteMovement } from "./use-home-favorite-movement";

export type HomeScreenProps = {
  mode?: "home" | "chats" | "new-chat";
  projectId: string;
  onOpenThread: (threadId: string) => void;
};

export function HomeScreen({ projectId, onOpenThread, mode = "home" }: HomeScreenProps) {
  const openNewChat = useOpenNewChatRoute();
  const feed = useHomeChatFeed(projectId);
  const { announce, announceError } = useAnnouncement();
  const movement = useHomeFavoriteMovement();
  const [now, setNow] = useState(Date.now());
  const [finePointer, setFinePointer] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    if (!media) return;
    const sync = () => setFinePointer(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const rowProps = {
    now,
    onOpen: (item: ProjectChatItem) => onOpenThread(item.id),
    onFavorite: (item: ProjectChatItem, value: boolean) => {
      const optimistic = movement.capture(item.id);
      movement.commit(optimistic);
      void feed
        .setFavorite(item.id, value, {
          beforeRollback: () => movement.commit(movement.capture(item.id)),
        })
        .then((saved) => {
          if (saved)
            announce(
              value
                ? t`${item.title} moved to Favorite chats`
                : t`${item.title} moved to Recent chats`,
            );
          else announceError(t`Favorite wasn’t saved`);
        });
    },
  };

  return (
    <div
      ref={movement.scrollRef}
      data-home-scroll-owner
      className="app-scroll main-pane"
      {...movement.interactionProps}
    >
      <div className="project-screen-column">
        <div className="flex flex-col gap-6">
          {mode !== "chats" ? (
            <section>
              <div className="mx-auto w-full max-w-3xl">
                <h1 className="home-composer-heading text-headline-section">
                  <Trans>What will you write next?</Trans>
                </h1>
                <p className="mt-2 text-body text-muted-foreground">
                  <Trans>Start with a scene, a question, or a problem to solve.</Trans>
                </p>
                <div className="mt-4">
                  <CreationComposer projectId={projectId} autoFocus={finePointer} />
                </div>
              </div>
            </section>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-headline-section">
                <Trans>Chats</Trans>
              </h1>
              <Button disabled={!openNewChat} onClick={() => void openNewChat?.()}>
                <Trans>New chat</Trans>
              </Button>
            </div>
          )}
          {mode !== "new-chat" ? (
            <HomeFeed projectId={projectId} feed={feed} rowProps={rowProps} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
