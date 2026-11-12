/**
 * SidePicker — the side header's name, and the list that chooses what sits beside main.
 *
 * It offers only the kind main is not: chats beside a document, documents beside a chat. Its
 * lists: for main's item (a document's chats; a chat's documents), recent documents, recent chats
 * with New chat, and one merged Find list while searching. Each section loads on its own. A choice
 * writes the project's current chat or document, which lasts until main changes mode.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { MessageSquare, Plus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useDocumentRelated } from "@/client/query/useDocumentRelated";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { ChooserMark } from "@/components/ui/marks";
import { Picker, PickerResults, PickerSearch, PickerSection } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterThreadsByTitle } from "@/features/chat/thread-switcher";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { matchFileSuggestions } from "../context/file-suggestions/file-suggestions";
import { titleChipClass } from "../shell/tab-chip";
import { type Item, useMainItem } from "../views";
import { useMainForSide, useShellCommands, useSideDescriptions, useSideItem } from "./SideView";
import { fitsBeside, sameItem } from "./side-item";

const RECENT_LIMIT = 6;
const FIND_LIMIT = 12;
const FIND_SCHEMES: readonly ProjectContextTreeScheme[] = ["manuscript", "kb", "user"];

type Row = {
  key: string;
  item: Item;
  name: string;
  meta?: string;
};

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
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
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
            query={query}
            onQueryChange={setQuery}
            searchRef={searchRef}
            onDone={() => changeOpen(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SidePickerLists({
  projectId,
  query,
  onQueryChange,
  searchRef,
  onDone,
}: {
  projectId: string;
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onDone: () => void;
}) {
  const main = useMainForSide();
  const mainDocument = useMainItem().document.document;
  const side = useSideItem();
  const descriptions = useSideDescriptions();
  const { swapSide } = useShellCommands(projectId);
  const mainDocumentId = main.kind === "document" ? main.documentId : null;
  const mainChatId = main.kind === "chat" ? main.chatId : null;
  const offersChats = fitsBeside({ kind: "chat", chatId: null }, main);
  const offersDocuments = fitsBeside({ kind: "document", documentId: "" }, main);

  const catalogs = useContextCatalogViews(projectId, FIND_SCHEMES, {});
  const loaded = FIND_SCHEMES.flatMap((scheme) => {
    const catalog = catalogs[scheme].catalog;
    return catalog ? [{ scheme, catalog }] : [];
  });

  const related = useDocumentRelated(projectId, mainDocumentId);
  const chatDocuments = useThreadRecentDocuments(mainChatId);
  const recent = useRecentDocuments(projectId);
  const { threads, isError: threadsFailed } = useProjectThreads(projectId);
  const chats = useMemo(
    () => (threads ?? []).filter((thread) => thread.kind !== "subagent" && !thread.deletedAt),
    [threads],
  );
  const chatTitle = (chatId: string, fallback?: string) => {
    const thread = chats.find((chat) => chat.id === chatId);
    return thread ? displayThreadTitle(thread.title) : (fallback ?? displayThreadTitle(null));
  };

  const shownNow = side.item;
  const keep = (rows: Row[]) => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.key) || !fitsBeside(row.item, main)) return false;
      seen.add(row.key);
      return true;
    });
  };
  // A chat's documents include its uploads and may name a removed one: only those that open
  // beside are offered.
  const touched = (chatDocuments.documents ?? []).filter((row) => row.kind === "tracked");
  const touchedIds = touched.map((row) => row.documentId).join(",");
  const { request } = descriptions;
  useEffect(() => {
    if (touchedIds) request(touchedIds.split(",").map((documentId) => ({ documentId })));
  }, [touchedIds, request]);

  const mainName = mainDocument?.name ?? null;
  const forThis: Row[] = keep(
    mainDocumentId
      ? [
          ...(related.data?.chats ?? []).map((chat) => ({
            key: `chat:${chat.chatId}`,
            item: { kind: "chat" as const, chatId: chat.chatId },
            name: chatTitle(chat.chatId, chat.title),
            meta: chat.edited ? t`Edited this` : t`Read this`,
          })),
        ]
      : mainChatId
        ? touched
            .filter((row) => {
              const described = descriptions.read({ documentId: row.documentId });
              return described.status === "ready" && described.document !== null;
            })
            .map((row) => ({
              key: `document:${row.documentId}`,
              item: { kind: "document" as const, documentId: row.documentId },
              name: row.name,
              meta: row.edited ? t`Wrote` : t`Read`,
            }))
        : [],
  );
  const forThisState =
    mainDocumentId && !related.data
      ? related.isError
        ? { failed: () => void related.refetch() }
        : "loading"
      : mainChatId && chatDocuments.status === "loading"
        ? "loading"
        : mainChatId && chatDocuments.status === "error"
          ? { failed: () => void chatDocuments.refetch() }
          : null;

  const recentDocuments: Row[] = keep(
    recent.documents.map((item) => ({
      key: `document:${item.documentId}`,
      item: { kind: "document" as const, documentId: item.documentId },
      name: item.name,
    })),
  ).slice(0, RECENT_LIMIT);
  const recentChats: Row[] = keep(
    chats.map((chat) => ({
      key: `chat:${chat.id}`,
      item: { kind: "chat" as const, chatId: chat.id },
      name: displayThreadTitle(chat.title),
    })),
  ).slice(0, RECENT_LIMIT);

  const search = query.trim();
  const searching = search.length > 0;
  const found: Row[] = searching
    ? keep([
        ...matchFileSuggestions(
          loaded.flatMap(({ scheme, catalog }) =>
            catalog.files().flatMap((file) =>
              file.editable
                ? [
                    {
                      entryId: file.documentId,
                      scheme,
                      path: file.path,
                      name: file.name,
                      kind: "file" as const,
                      parents: file.path.split("/").filter(Boolean).slice(0, -1),
                    },
                  ]
                : [],
            ),
          ),
          query,
        ).map((file) => ({
          key: `document:${file.entryId}`,
          item: { kind: "document" as const, documentId: file.entryId },
          name: file.name,
          meta: file.parents.at(-1),
        })),
        ...filterThreadsByTitle(chats, query).map((chat) => ({
          key: `chat:${chat.id}`,
          item: { kind: "chat" as const, chatId: chat.id },
          name: displayThreadTitle(chat.title),
        })),
      ]).slice(0, FIND_LIMIT)
    : [];

  const choose = (item: Item) => {
    swapSide(item);
    onDone();
  };
  const row = (item: Row) => (
    <li key={item.key}>
      <ListRow
        density="menu"
        current={sameItem(item.item, shownNow)}
        onOpen={() => choose(item.item)}
        leading={<ItemIcon item={item.item} name={item.name} />}
        title={item.name}
        meta={item.meta}
      />
    </li>
  );

  return (
    <Picker label={t`Beside`}>
      <PickerSearch
        ref={searchRef}
        value={query}
        onChange={onQueryChange}
        onSubmit={() => {
          const first = found[0];
          if (first) choose(first.item);
        }}
        label={
          offersChats && offersDocuments
            ? t`Find a document or chat`
            : offersChats
              ? t`Find a chat`
              : t`Find a document`
        }
      />
      <PickerResults bound="fill">
        {searching ? (
          <PickerSection
            label={t`Results`}
            state={
              found.length === 0 ? (
                <ListLine density="menu" iconSlot>
                  {offersChats && offersDocuments ? (
                    <Trans>No documents or chats match “{search}”.</Trans>
                  ) : offersChats ? (
                    <Trans>No chats match “{search}”.</Trans>
                  ) : (
                    <Trans>No documents match “{search}”.</Trans>
                  )}
                </ListLine>
              ) : undefined
            }
          >
            {found.map(row)}
          </PickerSection>
        ) : (
          <>
            {mainDocumentId || mainChatId ? (
              <PickerSection
                label={mainName ? t`For ${mainName}` : t`For this chat`}
                state={
                  forThisState === "loading" ? (
                    <ListLine density="menu" iconSlot status>
                      <Trans>Loading…</Trans>
                    </ListLine>
                  ) : forThisState ? (
                    <InlineErrorRow
                      message={
                        mainDocumentId
                          ? t`Couldn't load the chats for this document.`
                          : t`Couldn't load this chat's documents.`
                      }
                      onRetry={forThisState.failed}
                    />
                  ) : forThis.length === 0 ? (
                    <ListLine density="menu" iconSlot>
                      <Trans>Nothing yet</Trans>
                    </ListLine>
                  ) : undefined
                }
              >
                {forThis.map(row)}
              </PickerSection>
            ) : null}
            {offersDocuments ? (
              <PickerSection
                label={t`Recent documents`}
                state={
                  recentDocuments.length === 0 ? (
                    recent.status === "loading" ? (
                      <ListLine density="menu" iconSlot status>
                        <Trans>Loading…</Trans>
                      </ListLine>
                    ) : (
                      <ListLine density="menu" iconSlot>
                        <Trans>None yet</Trans>
                      </ListLine>
                    )
                  ) : undefined
                }
              >
                {recentDocuments.map(row)}
              </PickerSection>
            ) : null}
            {offersChats ? (
              <PickerSection
                label={t`Recent chats`}
                state={
                  threadsFailed ? (
                    <InlineErrorRow message={<Trans>Couldn't load chats.</Trans>} />
                  ) : threads === null ? (
                    <ListLine density="menu" iconSlot status>
                      <Trans>Loading…</Trans>
                    </ListLine>
                  ) : undefined
                }
              >
                <li>
                  <ListRow
                    density="menu"
                    current={shownNow?.kind === "chat" && shownNow.chatId === null}
                    onOpen={() => choose({ kind: "chat", chatId: null })}
                    leading={<Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    title={mainName ? t`New chat about ${mainName}` : t`New chat`}
                  />
                </li>
                {recentChats.map(row)}
              </PickerSection>
            ) : null}
          </>
        )}
      </PickerResults>
    </Picker>
  );
}

function ItemIcon({ item, name }: { item: Item; name: string }) {
  const Icon = item.kind === "chat" ? MessageSquare : fileKindIcon(name);
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}
