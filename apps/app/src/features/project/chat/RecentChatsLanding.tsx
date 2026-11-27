import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { WorkName } from "@/components/app/WorkName";
import { Button } from "@/components/ui/button";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import { SettledSearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { focusMain } from "@/features/editor/focus-on-open";
import { MainSurface } from "@/features/editor/MainSurface";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { RecencyGroupedList } from "../RecencyGroupedList";
import { relativeTime } from "../relative-time";
import { useChatNavigation } from "../routing/chat-navigation";
import { projectAddressHref } from "../routing/project-address";

export function RecentChatsLanding({ projectId }: { projectId: string }) {
  return (
    <MainSurface joined className="flex min-h-0 flex-1 flex-col">
      <ChatsLanding projectId={projectId} />
    </MainSurface>
  );
}

function ChatsLanding({ projectId }: { projectId: string }) {
  const chat = useChatNavigation();
  const [search, setSearch] = useState<string | null>(null);
  const feed = useProjectChatFeed(projectId, false, search);
  const now = useMinuteClock();
  const startChat = () => void chat.openNewChat();

  if (
    !search &&
    !feed.isPending &&
    !feed.isError &&
    !feed.isPlaceholderData &&
    feed.items.length === 0
  )
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 text-center">
        <p className="font-medium text-foreground">
          <Trans>No chats yet</Trans>
        </p>
        <Button size="sm" className="mt-5" onClick={startChat}>
          <MessageSquarePlus aria-hidden />
          <Trans>New chat</Trans>
        </Button>
      </div>
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(editorColumnChrome, "pt-16 pb-24")}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <h2 className={role.sectionHeading}>
            <Trans>Recent chats</Trans>
          </h2>
          <SettledSearchField
            label={t`Find a chat`}
            value={search}
            onSettle={setSearch}
            className="w-full sm:w-64"
          />
        </div>
        <div className="mt-7" aria-busy={feed.isFetching || undefined}>
          <RecentChats
            projectId={projectId}
            feed={feed}
            search={search}
            now={now}
            onOpen={(chatId) => {
              focusMain();
              void chat.openChat(chatId);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function RecentChats({
  projectId,
  feed,
  search,
  now,
  onOpen,
}: {
  projectId: string;
  feed: ReturnType<typeof useProjectChatFeed>;
  search: string | null;
  now: number;
  onOpen: (chatId: string) => void;
}) {
  if (feed.isPending)
    return (
      <div className="flex flex-col gap-2" role="status" aria-busy="true">
        <span className="sr-only">
          <Trans>Loading recent chats</Trans>
        </span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-11 w-full motion-reduce:animate-none" />
        ))}
      </div>
    );
  if (feed.isError && feed.items.length === 0)
    return (
      <InlineErrorRow
        message={<Trans>Couldn't load chats.</Trans>}
        onRetry={() => void feed.refetch()}
      />
    );
  if (search && feed.items.length === 0 && !feed.hasNextPage && !feed.isPlaceholderData)
    return (
      <ListLine>
        <Trans>No chats match “{search}”.</Trans>
      </ListLine>
    );
  return (
    <>
      <RecencyGroupedList
        items={feed.items}
        now={now}
        timestamp={(item) => item.lastActivityAt}
        itemKey={(item) => item.id}
        renderItem={(item) => (
          <RecentChatRow item={item} projectId={projectId} now={now} onOpen={onOpen} />
        )}
      />
      {feed.isError || feed.isFetchNextPageError ? (
        <p className="mt-5 text-xs text-muted-foreground">
          <Trans>Couldn't load more chats.</Trans>{" "}
          <button
            type="button"
            onClick={() => void (feed.isFetchNextPageError ? feed.fetchNextPage() : feed.refetch())}
            className="text-button text-xs"
          >
            <Trans>Retry</Trans>
          </button>
        </p>
      ) : feed.hasNextPage ? (
        <div className="-mx-1.5 mt-2">
          <ListRow
            onOpen={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
            title={
              <span className={role.secondary}>
                {feed.isFetchingNextPage ? <Trans>Loading more…</Trans> : <Trans>Show more</Trans>}
              </span>
            }
          />
        </div>
      ) : null}
    </>
  );
}

function RecentChatRow({
  item,
  projectId,
  now,
  onOpen,
}: {
  item: ProjectChatItem;
  projectId: string;
  now: number;
  onOpen: (chatId: string) => void;
}) {
  return (
    <div className="-mx-1.5">
      <ListRow
        href={projectAddressHref({ projectId, destination: { kind: "chat", chatId: item.id } })}
        onOpen={() => onOpen(item.id)}
        icon={MessageSquare}
        title={displayThreadTitle(item.title)}
        detail={
          item.work ? <WorkName work={{ ...item.work, name: item.work.title, projectId }} /> : null
        }
        meta={<span aria-hidden>{relativeTime(item.lastActivityAt, now)}</span>}
      />
    </div>
  );
}
