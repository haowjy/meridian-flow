/**
 * SidePicker — the side header's name, and the list that chooses what sits beside main.
 *
 * It offers one kind, the one main is not. Beside a document, chats as the sidebar lists them:
 * New chat, the scoped Work's chats (pinned first), then Other chats. Beside a chat, documents:
 * those open in main's tabs, then the file explorer over the project's areas. Search filters that
 * kind. A choice writes the project's current chat or document, which lasts until main changes mode.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { MessageSquare, Pin, Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { ChooserMark } from "@/components/ui/marks";
import { Picker, PickerResults, PickerSearch, PickerSection } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { role } from "@/components/ui/roles";
import { filterThreadsByTitle } from "@/features/chat/thread-switcher";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { useChatGroups } from "../shell/sidebar/use-chat-groups";
import { titleChipClass } from "../shell/tab-chip";
import { useWorkScope } from "../use-work-scope";
import { type Item, useMainItem } from "../views";
import { DocumentChoices } from "./DocumentChoices";
import { useMainForSide, useShellCommands, useSideItem } from "./SideView";

/** Unpinned chats a list shows at first, and adds with each Show more (the sidebar's page). */
const PAGE = 20;
const FIND_LIMIT = 12;

export function SidePicker({
  projectId,
  name,
  icon,
}: {
  projectId: string;
  /** What the side shows now, as its trigger names it; null while it shows nothing. */
  name: string | null;
  icon: ReactNode;
}) {
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            name === null ? t`Choose what sits beside` : t`Choose what sits beside, now ${name}`
          }
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn("focus-ring min-w-0 text-left", titleChipClass("quiet"))}
        >
          {icon}
          <span className="min-w-0 truncate text-xs font-medium">
            {name ?? t`Choose what sits beside`}
          </span>
          <ChooserMark />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        align="start"
        className={cn(
          dropdownSurfaceVariants({ measure: "catalog" }),
          "flex max-h-[min(32rem,70vh)]",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        {open ? (
          <SidePickerLists
            projectId={projectId}
            searchRef={searchRef}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SidePickerLists({
  projectId,
  searchRef,
  onDone,
}: {
  projectId: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onDone: () => void;
}) {
  const main = useMainForSide();
  const { swapSide } = useShellCommands(projectId);
  const choose = (item: Item) => {
    swapSide(item);
    onDone();
  };
  // Beside a chat or the new-chat composer, documents; otherwise (a document, the landing, a
  // document still opening) chats.
  return main.kind === "chat" || main.kind === "new-chat" ? (
    <DocumentChoices
      projectId={projectId}
      searchRef={searchRef}
      choose={(documentId) => choose({ kind: "document", documentId })}
    />
  ) : (
    <ChatChoices projectId={projectId} searchRef={searchRef} choose={choose} />
  );
}

const chatItem = (chatId: string): Item => ({ kind: "chat", chatId });

/** Beside a document: the sidebar's order, New chat first. */
function ChatChoices({
  projectId,
  searchRef,
  choose,
}: {
  projectId: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  choose: (item: Item) => void;
}) {
  const [query, setQuery] = useState("");
  const mainName = useMainItem().document.document?.name ?? null;
  const shown = useSideItem().item;
  const { workId } = useWorkScope(projectId);
  const { noWork } = useWorks(projectId);
  const { threads, failed, groups, pinnedIds } = useChatGroups(
    projectId,
    workId,
    noWork?.id ?? null,
  );
  const search = query.trim();
  const found = search
    ? filterThreadsByTitle(
        (threads ?? []).filter((thread) => thread.kind !== "subagent" && !thread.deletedAt),
        query,
      ).slice(0, FIND_LIMIT)
    : [];
  const row = (chat: ThreadListItem) => {
    const Icon = pinnedIds.has(chat.id) ? Pin : MessageSquare;
    return (
      <li key={chat.id}>
        <ListRow
          density="menu"
          current={shown?.kind === "chat" && shown.chatId === chat.id}
          onOpen={() => choose(chatItem(chat.id))}
          leading={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          title={displayThreadTitle(chat.title)}
        />
      </li>
    );
  };
  const loading = (
    <ListLine density="menu" iconSlot status>
      <Trans>Loading…</Trans>
    </ListLine>
  );
  const state = failed ? (
    <InlineErrorRow message={<Trans>Couldn't load chats.</Trans>} />
  ) : threads === null ? (
    loading
  ) : undefined;
  return (
    <Picker label={t`Beside`}>
      <PickerSearch
        ref={searchRef}
        value={query}
        onChange={setQuery}
        onSubmit={() => {
          const first = found[0];
          if (first) choose(chatItem(first.id));
        }}
        label={t`Find a chat`}
      />
      <PickerResults bound="fill">
        {search ? (
          <PickerSection
            label={t`Results`}
            state={
              found.length === 0 ? (
                <ListLine density="menu" iconSlot>
                  <Trans>No chats match “{search}”.</Trans>
                </ListLine>
              ) : undefined
            }
          >
            {found.map(row)}
          </PickerSection>
        ) : (
          <>
            <PickerSection>
              <li>
                <ListRow
                  density="menu"
                  current={shown?.kind === "chat" && shown.chatId === null}
                  onOpen={() => choose({ kind: "chat", chatId: null })}
                  leading={<Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  title={mainName ? t`New chat about ${mainName}` : t`New chat`}
                />
              </li>
            </PickerSection>
            <PickerSection state={state}>
              <PagedChats pinned={groups.pinned} chats={groups.scoped} row={row} />
            </PickerSection>
            {groups.othersPinned.length + groups.others.length > 0 ? (
              <PickerSection label={t`Other chats`}>
                <PagedChats pinned={groups.othersPinned} chats={groups.others} row={row} />
              </PickerSection>
            ) : null}
          </>
        )}
      </PickerResults>
    </Picker>
  );
}

/** A list's pinned chats, then its other chats a page at a time, as the sidebar pages them. */
function PagedChats({
  pinned,
  chats,
  row,
}: {
  pinned: readonly ThreadListItem[];
  chats: readonly ThreadListItem[];
  row: (chat: ThreadListItem) => ReactNode;
}) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      {pinned.map(row)}
      {chats.slice(0, shown).map(row)}
      {chats.length > shown ? (
        <li>
          <ListRow
            density="menu"
            onOpen={() => setShown(shown + PAGE)}
            title={
              <span className={role.secondary}>
                <Trans>Show more</Trans>
              </span>
            }
          />
        </li>
      ) : null}
    </>
  );
}
