/**
 * The Work page's Chats tab: this Work's chats, searched as the chat index is,
 * and New chat (disabled in place while the Work is archived, which takes no
 * new chats).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkArchived } from "@meridian/contracts/works";
import { MessageSquarePlus } from "lucide-react";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import type { AddressableWork } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { NextPage } from "../chat-index/ChatIndex";
import { ChatIndexList, type ChatIndexRowProps } from "../chat-index/ChatIndexList";
import { ChatIndexLoading } from "../chat-index/ChatIndexLoading";
import { useChatRowCommands } from "../chat-list/useChatRowCommands";
import { useChatNavigation } from "../routing/chat-navigation";
import { SettledSearchField } from "../SearchField";
import { WorkToolbarTools } from "./WorkToolbarSlot";

export function WorkChatsTab({
  projectId,
  work,
  scrollOwner,
}: {
  projectId: string;
  work: AddressableWork;
  scrollOwner: RefObject<HTMLDivElement | null>;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const feed = useProjectChatFeed(projectId, false, search, work.id);
  const now = useMinuteClock();
  const { openChat, openNewChat } = useChatNavigation();
  const { onFavorite, onDelete, deleteFailure, retryDelete, deleteDialog } =
    useChatRowCommands(projectId);
  const onOpen = useCallback<ChatIndexRowProps["onOpen"]>(
    (item) => void openChat(item.id),
    [openChat],
  );
  const rowProps: ChatIndexRowProps = useMemo(
    () => ({ onFavorite, onDelete, now, onOpen }),
    [onFavorite, onDelete, now, onOpen],
  );
  return (
    <>
      <WorkToolbarTools>
        <SettledSearchField label={t`Search chats`} value={search} onSettle={setSearch} />
        <Button
          size="sm"
          disabled={isWorkArchived(work)}
          onClick={() => void openNewChat(work.id)}
          aria-label={t`New chat`}
          className="[@media(pointer:coarse)]:min-h-11"
        >
          <MessageSquarePlus aria-hidden />
          <span className="max-sm:hidden" aria-hidden>
            <Trans>New chat</Trans>
          </span>
        </Button>
      </WorkToolbarTools>
      {feed.isPending ? (
        <ChatIndexLoading />
      ) : feed.isError && !feed.data ? (
        <InlineErrorRow
          message={<Trans>Chats couldn’t load</Trans>}
          onRetry={() => void feed.refetch()}
        />
      ) : !feed.items.length && !feed.hasNextPage && !feed.isPlaceholderData ? (
        <div className="py-4">
          {search ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No chats match “{search}”.</Trans>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>Chats in this Work share its goal and scratch files.</Trans>
            </p>
          )}
        </div>
      ) : (
        <>
          <ChatIndexList
            projectId={projectId}
            items={feed.items}
            complete={!feed.hasNextPage}
            busy={feed.isFetching}
            scrollOwner={scrollOwner}
            rowProps={rowProps}
            deleteFailure={deleteFailure}
            retryDelete={retryDelete}
          />
          <NextPage feed={feed} />
        </>
      )}
      {deleteDialog}
    </>
  );
}
