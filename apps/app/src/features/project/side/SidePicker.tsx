/**
 * SidePicker — the side header's name, and the list that chooses what sits beside main.
 *
 * Its lists (plan §4.4): for main's item (a document's chats, its previous chapter, the pages it
 * mentions; a chat's documents), recent documents, recent chats with New chat, and one merged
 * Find list while searching. Each section loads on its own. Main's own item never appears, and
 * no chat is offered beside a chat. A pick holds the side; "Follow" releases it.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronsUpDown, MessageSquare, Pin, Plus, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { HeldPick } from "@/client/project-shell/store";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useDocumentRelated } from "@/client/query/useDocumentRelated";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import {
  Picker,
  PickerLine,
  PickerResults,
  PickerRow,
  PickerSearch,
  PickerSection,
} from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterThreadsByTitle } from "@/features/chat/thread-switcher";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { matchFileSuggestions } from "../context/file-suggestions/file-suggestions";
import { titleChipClass } from "../shell/tab-chip";
import { useMainItem } from "../views";
import { useMainForSide, useShellCommands, useSideDescriptions, useSideItem } from "./SideView";
import { fitsBeside, sameItem } from "./side-item";

const RECENT_LIMIT = 6;
const FIND_LIMIT = 12;
const FIND_SCHEMES: readonly ProjectContextTreeScheme[] = ["manuscript", "kb", "user"];

type Row = {
  key: string;
  pick: HeldPick;
  name: string;
  meta?: string;
};

export function SidePicker({
  projectId,
  name,
  icon,
  chatsOnly = false,
}: {
  projectId: string;
  /** What the side shows now, as its trigger names it. */
  name: string;
  icon: ReactNode;
  /** The phone's sheet holds chats only. */
  chatsOnly?: boolean;
}) {
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-side-picker-trigger
          aria-label={t`Choose what sits beside, now ${name}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn("focus-ring min-w-0 text-left", titleChipClass("quiet"))}
        >
          {icon}
          <span className="min-w-0 truncate text-sm font-medium">{name}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
            chatsOnly={chatsOnly}
            trigger={triggerRef}
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
  chatsOnly,
  trigger,
  onDone,
}: {
  projectId: string;
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  chatsOnly: boolean;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onDone: () => void;
}) {
  const main = useMainForSide();
  const mainDocument = useMainItem().document.tab;
  const side = useSideItem();
  const descriptions = useSideDescriptions();
  const { pickSide, releaseSide } = useShellCommands(projectId);
  const mainDocumentId = main.kind === "document" ? main.documentId : null;
  const mainChatId = main.kind === "chat" ? main.chatId : null;
  const offersChats = fitsBeside({ kind: "chat", chatId: null }, main, chatsOnly);
  const offersDocuments = !chatsOnly;

  const catalogs = useContextCatalogViews(projectId, FIND_SCHEMES, { enabled: offersDocuments });
  const loaded = FIND_SCHEMES.flatMap((scheme) => {
    const catalog = catalogs[scheme].catalog;
    return catalog ? [{ scheme, catalog }] : [];
  });
  const nameOf = (documentId: string) => findInCatalogs(loaded, documentId)?.name ?? null;

  const related = useDocumentRelated(projectId, mainDocumentId);
  const chatDocuments = useThreadRecentDocuments(offersDocuments ? mainChatId : null);
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
      if (seen.has(row.key) || !fitsBeside(row.pick, main, chatsOnly)) return false;
      seen.add(row.key);
      return true;
    });
  };
  // A chat's documents include its uploads and may name a removed one: only those that open
  // beside are offered.
  const touched = offersDocuments
    ? (chatDocuments.documents ?? []).filter((row) => row.kind === "tracked")
    : [];
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
            pick: { kind: "chat" as const, chatId: chat.chatId },
            name: chatTitle(chat.chatId, chat.title),
            meta: chat.edited ? t`Edited this` : t`Read this`,
          })),
          ...previousChapter(loaded, mainDocumentId).map((file) => ({
            key: `document:${file.documentId}`,
            pick: { kind: "document" as const, documentId: file.documentId },
            name: file.name,
            meta: t`Previous chapter`,
          })),
          ...(related.data?.mentions ?? []).flatMap((mention) => {
            const name = nameOf(mention.documentId);
            return name
              ? [
                  {
                    key: `document:${mention.documentId}`,
                    pick: { kind: "document" as const, documentId: mention.documentId },
                    name,
                    meta: t`Mentioned`,
                  },
                ]
              : [];
          }),
        ]
      : mainChatId
        ? touched
            .filter((row) => {
              const described = descriptions.read({ documentId: row.documentId });
              return described.status === "ready" && described.tab !== null;
            })
            .map((row) => ({
              key: `document:${row.documentId}`,
              pick: { kind: "document" as const, documentId: row.documentId },
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
      pick: { kind: "document" as const, documentId: item.documentId },
      name: item.name,
    })),
  ).slice(0, RECENT_LIMIT);
  const recentChats: Row[] = keep(
    chats.map((chat) => ({
      key: `chat:${chat.id}`,
      pick: { kind: "chat" as const, chatId: chat.id },
      name: displayThreadTitle(chat.title),
    })),
  ).slice(0, RECENT_LIMIT);

  const searching = query.trim().length > 0;
  const found: Row[] = searching
    ? keep([
        ...(offersDocuments
          ? matchFileSuggestions(
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
              pick: { kind: "document" as const, documentId: file.entryId },
              name: file.name,
              meta: file.parents.at(-1),
            }))
          : []),
        ...filterThreadsByTitle(chats, query).map((chat) => ({
          key: `chat:${chat.id}`,
          pick: { kind: "chat" as const, chatId: chat.id },
          name: displayThreadTitle(chat.title),
        })),
      ]).slice(0, FIND_LIMIT)
    : [];

  const choose = (pick: HeldPick) => {
    const moves = !sameItem(pick, shownNow);
    pickSide(pick);
    onDone();
    if (moves) focusTriggerAfterPick(trigger.current);
  };
  const row = (item: Row) => (
    <PickerRow
      key={item.key}
      current={sameItem(item.pick, shownNow)}
      onSelect={() => choose(item.pick)}
      leading={<ItemIcon pick={item.pick} name={item.name} />}
      title={item.name}
      meta={item.meta}
      trailing={
        side.source === "held" && sameItem(item.pick, shownNow) ? (
          <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label={t`Held`} />
        ) : null
      }
    />
  );

  return (
    <Picker label={t`Beside`}>
      <PickerSearch
        ref={searchRef}
        value={query}
        onChange={onQueryChange}
        onSubmit={() => {
          const first = found[0];
          if (first) choose(first.pick);
        }}
        label={offersDocuments ? t`Find a document or chat` : t`Find a chat`}
      />
      <PickerResults bound="fill">
        {searching ? (
          <PickerSection
            label={t`Results`}
            state={
              found.length === 0 ? (
                <PickerLine>
                  <Trans>No matches</Trans>
                </PickerLine>
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
                    <PickerLine>
                      <Trans>Loading…</Trans>
                    </PickerLine>
                  ) : forThisState ? (
                    <InlineErrorRow
                      message={t`Couldn't load what goes with this.`}
                      onRetry={forThisState.failed}
                    />
                  ) : forThis.length === 0 && side.source !== "held" ? (
                    <PickerLine>
                      <Trans>Nothing yet</Trans>
                    </PickerLine>
                  ) : undefined
                }
              >
                {side.source === "held" ? (
                  <PickerRow
                    onSelect={() => {
                      releaseSide();
                      onDone();
                    }}
                    leading={
                      <Undo2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    }
                    title={mainName ? t`Follow ${mainName}` : t`Follow this chat`}
                  />
                ) : null}
                {forThis.map(row)}
              </PickerSection>
            ) : null}
            {offersDocuments ? (
              <PickerSection
                label={t`Recent documents`}
                state={
                  recentDocuments.length === 0 ? (
                    <PickerLine>
                      {recent.status === "loading" ? (
                        <Trans>Loading…</Trans>
                      ) : (
                        <Trans>None yet</Trans>
                      )}
                    </PickerLine>
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
                    <PickerLine>
                      <Trans>Couldn't load chats</Trans>
                    </PickerLine>
                  ) : threads === null ? (
                    <PickerLine>
                      <Trans>Loading…</Trans>
                    </PickerLine>
                  ) : undefined
                }
              >
                <PickerRow
                  current={shownNow?.kind === "chat" && shownNow.chatId === null}
                  onSelect={() => choose({ kind: "chat", chatId: null })}
                  leading={<Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  title={mainName ? t`New chat about ${mainName}` : t`New chat`}
                />
                {recentChats.map(row)}
              </PickerSection>
            ) : null}
          </>
        )}
      </PickerResults>
    </Picker>
  );
}

/**
 * A pick can move the side to another host (a document's in place of the chat's), whose header
 * mounts a new trigger: the focus the popover returns to the old one is lost when it unmounts.
 * For a few frames after the pick, while focus is still on the old trigger or nowhere, the new
 * trigger takes it; focus the writer moved elsewhere stays.
 */
function focusTriggerAfterPick(from: HTMLElement | null) {
  let frames = 0;
  const check = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== from) return;
    const next = [...document.querySelectorAll<HTMLElement>("[data-side-picker-trigger]")].find(
      (trigger) => trigger !== from && !trigger.closest("[inert]"),
    );
    if (next) next.focus();
    else if (++frames < 10) requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

function ItemIcon({ pick, name }: { pick: HeldPick; name: string }) {
  const Icon = pick.kind === "chat" ? MessageSquare : fileKindIcon(name);
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function findInCatalogs(loaded: readonly { catalog: CatalogContextView }[], documentId: string) {
  for (const { catalog } of loaded) {
    const file = catalog.findDocument(documentId);
    if (file) return file;
  }
  return null;
}

/** The document before this one in its folder's order, from the catalog replica. */
function previousChapter(loaded: readonly { catalog: CatalogContextView }[], documentId: string) {
  for (const { catalog } of loaded) {
    const file = catalog.findDocument(documentId);
    if (!file) continue;
    const siblings = catalog.children(file.parentId);
    const at = siblings.findIndex((node) => node.kind === "file" && node.documentId === documentId);
    for (let index = at - 1; index >= 0; index -= 1) {
      const node = siblings[index];
      if (node?.kind === "file" && node.editable) return [node];
    }
    return [];
  }
  return [];
}
