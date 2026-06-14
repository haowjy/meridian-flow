// @ts-nocheck
/**
 * MobileHomeScreen — phone presentation for the shared Home overview body.
 *
 * The data/filter/create-chat body stays in `home/HomeScreen`; this module owns
 * only the phone list chrome so mobile presentation does not leak back into the
 * desktop Home destination.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

import type { ChatRow } from "../home/chats-overview";
import { HomeOverviewBody, type HomeScreenProps, StatusDot } from "../home/HomeScreen";
import { relativeTime } from "../relative-time";

export function MobileHomeScreen(props: HomeScreenProps) {
  return <HomeOverviewBody {...props}>{(state) => <MobileChatList {...state} />}</HomeOverviewBody>;
}

function MobileChatList({
  loaded,
  rows,
  visible,
  onSelectThread,
}: {
  loaded: boolean;
  rows: ChatRow[];
  visible: ChatRow[];
  onSelectThread: (threadId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-mobile-home-list>
      {!loaded ? (
        <MobileEmptyCard>
          <Trans>Loading chats…</Trans>
        </MobileEmptyCard>
      ) : visible.length === 0 ? (
        <MobileEmptyCard>
          {rows.length === 0 ? (
            <Trans>No chats yet — start one to get going.</Trans>
          ) : (
            <Trans>Nothing matches this filter.</Trans>
          )}
        </MobileEmptyCard>
      ) : (
        visible.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onSelectThread(row.id)}
            className="focus-ring flex min-h-16 flex-col gap-2 rounded-xl border border-border-subtle bg-card px-4 py-3 text-left transition-colors active:scale-[0.99]"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              <StatusDot row={row} />
              <span className="min-w-0 flex-1 truncate">{row.title || t`New chat`}</span>
            </span>
            <span className="flex items-center justify-between gap-3 text-meta text-muted-foreground">
              <span className="min-w-0 truncate">{row.workLabel ?? "—"}</span>
              <span className="shrink-0 tabular-nums">
                {relativeTime(row.updatedAt, Date.now())}
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function MobileEmptyCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
