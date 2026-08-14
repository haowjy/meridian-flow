/** Home query, mutations, creation, announcements, and movement orchestration. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useHomeChatFeed } from "@/client/query/useHomeChatFeed";
import { useAnnouncement } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { useCreateChat } from "../chat/use-create-chat";
import { HomeFeed } from "./HomeFeed";
import { useHomeFavoriteMovement } from "./use-home-favorite-movement";

export type HomeScreenProps = { projectId: string; onSelectThread: (threadId: string) => void };
export function HomeScreen({ projectId, onSelectThread }: HomeScreenProps) {
  const feed = useHomeChatFeed(projectId);
  const creation = useCreateChat(projectId, onSelectThread);
  const { announce, announceError } = useAnnouncement();
  const movement = useHomeFavoriteMovement();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const cardProps = {
    now,
    onOpen: (item: HomeChatItem) => {
      if (item.attention !== "none") void feed.setUnread(item.id, false);
      onSelectThread(item.id);
    },
    onFavorite: (item: HomeChatItem, value: boolean, keyboard: boolean) => {
      const optimistic = movement.capture(item.id, keyboard);
      movement.commit(optimistic);
      void feed
        .setFavorite(item.id, value, {
          beforeRollback: () => movement.commit(movement.capture(item.id, keyboard)),
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
    onUnread: async (item: HomeChatItem, value: boolean) => {
      const saved = await feed.setUnread(item.id, value);
      if (!saved) announceError(t`Read status wasn’t saved`);
      return saved;
    },
    getCommandState: feed.getCommandState,
  };
  const newChat = <NewChatButton {...creation} />;
  const newChatError = creation.createError ? (
    <InlineErrorRow message={creation.createError.message} onRetry={creation.createChat} />
  ) : undefined;
  return (
    <div ref={movement.scrollRef} className="app-scroll">
      <HomeFeed feed={feed} cardProps={cardProps} newChat={newChat} newChatError={newChatError} />
    </div>
  );
}
function NewChatButton({ createChat, creating }: ReturnType<typeof useCreateChat>) {
  return (
    <Button
      className="min-w-32"
      type="button"
      onClick={createChat}
      disabled={creating}
      aria-busy={creating || undefined}
    >
      <Plus className="size-4" />
      {creating ? <Trans>Creating chat…</Trans> : <Trans>New chat</Trans>}
    </Button>
  );
}
