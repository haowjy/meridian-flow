/**
 * ChatIndexList — the chat index's rows, virtualized inside the page scroll.
 *
 * Chats grow without bound, so only rows near the viewport mount. Recency
 * labels and rows are one flat run of entries; a row draws its rule only when
 * the next entry is a row of its group, since mounted neighbors are not the
 * list's real neighbors.
 */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useCallback, useMemo } from "react";
import { useExternalScrollVirtualList } from "@/hooks/use-external-scroll-virtual-list";
import { cn } from "@/lib/utils";
import { ProjectChatFeedRow, type ProjectChatRowProps } from "../chat-list/ProjectChatRow";
import type { ChatRowDeleteFailure } from "../chat-list/useChatRowCommands";
import { type RecencyGroup, RecencyGroupLabel, recencyGroups } from "../RecencyGroupedList";

export type ChatIndexRowProps = Omit<
  ProjectChatRowProps,
  "item" | "favorite" | "onActiveChange" | "deleteError"
>;

type Entry =
  | { kind: "group"; key: string; group: RecencyGroup; first: boolean }
  | { kind: "chat"; key: string; item: ProjectChatItem; position: number; ruled: boolean };

const entryKey = (entry: Entry) => entry.key;

export function ChatIndexList({
  projectId,
  items,
  complete,
  busy,
  scrollOwner,
  rowProps,
  deleteFailure,
  retryDelete,
}: {
  projectId: string;
  /** Loaded chats, newest first. */
  items: readonly ProjectChatItem[];
  /** Every chat is loaded, so the row count is known. */
  complete: boolean;
  busy: boolean;
  scrollOwner: React.RefObject<HTMLElement | null>;
  rowProps: ChatIndexRowProps;
  /** Set only for the row whose optimistic delete failed and was restored. */
  deleteFailure?: ChatRowDeleteFailure | null;
  retryDelete?: () => void;
}) {
  const entries = useMemo(() => {
    const flat: Entry[] = [];
    let position = 0;
    recencyGroups(items, rowProps.now, (item) => item.lastActivityAt).forEach((bucket, index) => {
      flat.push({
        kind: "group",
        key: `group:${bucket.group}`,
        group: bucket.group,
        first: !index,
      });
      bucket.items.forEach((item, row) => {
        position += 1;
        flat.push({
          kind: "chat",
          key: item.id,
          item,
          position,
          ruled: row < bucket.items.length - 1,
        });
      });
    });
    return flat;
  }, [items, rowProps.now]);
  // Estimates only place unmeasured entries; mounted ones are measured.
  const estimateSize = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (entry?.kind === "group") return entry.first ? 24 : 52;
      return 54;
    },
    [entries],
  );
  const { listRef, onActiveChange, virtualizer } = useExternalScrollVirtualList({
    items: entries,
    scrollOwner,
    getItemKey: entryKey,
    estimateSize,
  });

  return (
    <ul
      ref={listRef}
      aria-busy={busy || undefined}
      // Rows own a hover wash with inner padding; bleed it so row text lines up
      // with the search row and group labels, and inset the rules by the bleed.
      className="relative -mx-2 [--row-rule-inset:--spacing(2)]"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtual) => {
        const entry = entries[virtual.index];
        if (!entry) return null;
        const style = {
          transform: `translateY(${virtual.start - virtualizer.options.scrollMargin}px)`,
        };
        if (entry.kind === "group") {
          return (
            <li
              key={entry.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              role="none"
              className="absolute top-0 left-0 w-full px-2"
              style={style}
            >
              <RecencyGroupLabel group={entry.group} first={entry.first} />
            </li>
          );
        }
        const deleteError =
          deleteFailure?.id === entry.item.id && retryDelete
            ? { error: deleteFailure.error, onRetry: retryDelete }
            : undefined;
        return (
          <li
            key={entry.key}
            ref={virtualizer.measureElement}
            data-index={virtual.index}
            aria-posinset={entry.position}
            aria-setsize={complete ? items.length : -1}
            className={cn("absolute top-0 left-0 w-full", entry.ruled && "row-rule")}
            style={style}
          >
            <ProjectChatFeedRow
              projectId={projectId}
              item={entry.item}
              {...rowProps}
              deleteError={deleteError}
              onActiveChange={onActiveChange}
            />
          </li>
        );
      })}
    </ul>
  );
}
