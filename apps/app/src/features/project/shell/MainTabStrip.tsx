/**
 * MainTabStrip — main's open items as folder tabs in main's band (`client/project-shell/main-tabs`).
 * The tab main shows is the active chip, joined to the page below it. Main's item when the record
 * holds no tab for it (a chat, an address that names nothing, a document back within one history
 * entry) is drawn after the tabs as the active chip, so what main shows never depends on the record.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { useRouter } from "@tanstack/react-router";
import { FileQuestion, Plus, X } from "lucide-react";
import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type WheelEvent,
} from "react";
import {
  closeMainTab,
  type MainTab,
  mainTabKey,
  readMainTabs,
  useMainTabs,
} from "@/client/project-shell/main-tabs";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { OpenDocument } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { draftCopyView } from "@/features/draft-review/copy-view";
import { cn } from "@/lib/utils";
import { useAccountId, useAccountResourceProjection } from "../context/account-feature-context";
import { fileKindIcon } from "../context/context-file-icon";
import { useReferenceDrag } from "../context/entry-drag/reference-source";
import { projectResourceDocument } from "../context/open-document-from-file";
import { tabSubject } from "../context/tab-subject";
import { useIsDraftOnly } from "../context/use-is-draft-only";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { useDocumentPaint } from "../views";
import { tabChipClass } from "./tab-chip";

/** Selecting and closing main's tabs: each writes the address from the tab it names. */
export function useMainTabCommands({
  projectId,
  open,
  mainKey,
  onShowRecents,
}: {
  projectId: string;
  open: OpenContextRoute;
  /** The tab main shows; null while main holds no tab. */
  mainKey: string | null;
  onShowRecents: (options: { replace: boolean }) => void;
}) {
  const accountId = useAccountId();
  const openInMain = useOpenInMain(projectId, open);
  const show = useCallback(
    (tab: MainTab | null) => {
      if (tab) openInMain(tab.document, { replace: true });
      else onShowRecents({ replace: true });
    },
    [openInMain, onShowRecents],
  );
  return {
    select: (document: OpenDocument) => openInMain(document),
    close: (tab: MainTab) => {
      const key = mainTabKey(tab);
      const next = closeMainTab(accountId, projectId, key, mainKey);
      if (key === mainKey) show(next);
    },
    /** Main's item holds no tab: main goes to the tab it showed last, else Recently opened. */
    closeMain: () => {
      const { tabs, selected } = readMainTabs(accountId, projectId);
      show(tabs.find((tab) => mainTabKey(tab) === selected) ?? tabs.at(-1) ?? null);
    },
  };
}

export function MainTabStrip({
  projectId,
  open,
  mainKey,
  mainDocument,
  current,
  onShowRecents,
  onNewDocument,
}: {
  projectId: string;
  open: OpenContextRoute;
  mainKey: string | null;
  /** The document main shows, drawn as the active chip after the tabs when the record lacks it. */
  mainDocument?: OpenDocument;
  /** Main's item when it is not a document, drawn as the active chip after the tabs. */
  current?: ReactNode;
  onShowRecents: (options: { replace: boolean }) => void;
  /** Absent while no Work is ready to hold an Untitled document. */
  onNewDocument?: () => void;
}) {
  const accountId = useAccountId();
  const tabs = useLiveTabs(projectId, useMainTabs(accountId, projectId).tabs);
  const commands = useMainTabCommands({ projectId, open, mainKey, onShowRecents });
  const stripRef = useRef<HTMLDivElement>(null);
  const unrecorded =
    mainDocument && mainKey && !tabs.some((tab) => mainTabKey(tab) === mainKey)
      ? mainDocument
      : undefined;
  useActiveTabVisibility(stripRef, mainKey ?? (current ? "current" : null));
  const lastActive =
    current || unrecorded ? true : tabs.at(-1) && mainTabKey(tabs.at(-1) as MainTab) === mainKey;
  return (
    <div
      role="tablist"
      aria-label={t`Open documents`}
      className="flex h-full min-w-0 shrink items-stretch"
    >
      {/* The padding is room for the end tabs' flares, which this scroller would clip; the
          negative margins take it back, so the first tab starts where the chip before it ends. */}
      <div
        ref={stripRef}
        onWheel={scrollStripWithWheel}
        className="-mx-1.5 flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden px-1.5"
      >
        {tabs.map((tab, index) => {
          const active = mainTabKey(tab) === mainKey;
          const previous = tabs[index - 1];
          return (
            <DocumentTabChip
              key={mainTabKey(tab)}
              projectId={projectId}
              document={tab.document}
              active={active}
              // A divider only between two inactive tabs: the active tab's shape separates itself.
              divider={!active && previous !== undefined && mainTabKey(previous) !== mainKey}
              onSelect={(document) => commands.select(document)}
              onClose={() => commands.close(tab)}
            />
          );
        })}
        {unrecorded ? (
          <DocumentTabChip
            key={mainKey}
            projectId={projectId}
            document={unrecorded}
            active
            divider={false}
            onSelect={(document) => commands.select(document)}
            onClose={() => commands.close({ kind: "document", document: unrecorded })}
          />
        ) : null}
        {current}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNewDocument}
            disabled={!onNewDocument}
            title={!onNewDocument ? t`Open a Work to create an Untitled document` : undefined}
            aria-label={t`New document`}
            className="focus-ring relative isolate grid h-full w-10 shrink-0 place-items-center text-muted-foreground before:absolute before:inset-x-1 before:inset-y-1 before:-z-10 before:rounded-md before:transition-colors hover:text-foreground hover:before:bg-ink-fill"
          >
            {tabs.length > 0 && !lastActive ? (
              <span
                aria-hidden
                className="absolute top-1/2 left-0 h-3.5 w-px -translate-y-1/2 bg-border"
              />
            ) : null}
            <Plus className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Trans>New document</Trans>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

const PROJECT_SCOPED_SCHEMES: ReadonlySet<string> = new Set(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

/**
 * The tabs whose documents are not deleted. A record read from sessionStorage can name a document
 * deleted while the window was closed: once the replica holds the project's catalog, a Project's
 * document it neither places nor knows as removed is gone. Drawing skips such a tab and leaves the
 * record alone, so a document the replica later shows live again has its tab back.
 */
function useLiveTabs(projectId: string, tabs: readonly MainTab[]): readonly MainTab[] {
  const { records, placement } = useAccountResourceProjection(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  return useMemo(
    () =>
      tabs.filter(({ document }) => {
        const { kind } = projectResourceDocument(
          document,
          records,
          placement,
          isDraftOnly(document.documentId),
        );
        if (kind === "terminal" || kind === "removed") return false;
        return (
          kind !== "none" ||
          records.length === 0 ||
          document.kind === "new" ||
          !PROJECT_SCOPED_SCHEMES.has(document.scheme) ||
          isDraftOnly(document.documentId)
        );
      }),
    [tabs, records, placement, isDraftOnly],
  );
}

/**
 * A tab's document at its current descriptor: the replica's placement follows a rename or a move
 * made anywhere, as an off-main host does (`DocumentHost`).
 */
function useLiveTabDocument(projectId: string, document: OpenDocument): OpenDocument {
  const { records, placement } = useAccountResourceProjection(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  const projected = projectResourceDocument(
    document,
    records,
    placement,
    isDraftOnly(document.documentId),
  );
  return projected.kind === "projected" ? projected.document : document;
}

function DocumentTabChip({
  projectId,
  document: opened,
  active,
  divider,
  onSelect,
  onClose,
}: {
  projectId: string;
  document: OpenDocument;
  active: boolean;
  divider: boolean;
  onSelect: (document: OpenDocument) => void;
  onClose: () => void;
}) {
  const document = useLiveTabDocument(projectId, opened);
  // The active tab names what main paints: its draft while main reviews one.
  const paint = useDocumentPaint(projectId, active ? document : null);
  const drafts = useOwnerDrafts(projectId, paint.draft?.ownerKey ?? null);
  const file = paint.draft ? drafts.fileForDocument(document.documentId) : null;
  const reviewing = active && paint.showing === "draft";
  const isDraftOnly = useIsDraftOnly(projectId);
  const drag = useReferenceDrag(
    tabSubject(
      document,
      {
        reviewing,
        view: file && paint.draft ? draftCopyView(file, paint.draft.ownerKey) : null,
      },
      isDraftOnly(document.documentId),
    ),
  );
  const Icon = fileKindIcon(document.name);
  return (
    <TabChipFrame active={active} reviewing={reviewing} divider={divider} tabProps={drag}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={document.name}
        onClick={() => onSelect(document)}
        onAuxClick={(event) => {
          if (event.button === 1) onClose();
        }}
        // The whole chip is the hit target; the close button sits above it. The overlay carries
        // the name, so the visible label is hidden from assistive tech.
        className="focus-ring absolute inset-0"
        title={document.kind === "new" ? document.name : document.path}
      />
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left text-xs">
        {document.name}
      </span>
      <TabCloseButton name={document.name} active={active} onClose={onClose} />
    </TabChipFrame>
  );
}

/** Main's address names nothing: its tab says so, and closing it leaves the address. */
export function UnavailableTabChip({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <TabChipFrame active divider={false}>
      <FileQuestion aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        role="tab"
        aria-selected
        tabIndex={-1}
        className="min-w-0 flex-1 truncate text-left text-xs"
      >
        {name}
      </span>
      <TabCloseButton name={name} active onClose={onClose} />
    </TabChipFrame>
  );
}

function TabCloseButton({
  name,
  active,
  onClose,
}: {
  name: string;
  active: boolean;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t`Close ${name}`}
      className={cn(
        "focus-ring relative grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground transition-opacity",
        "hover:bg-ink-fill hover:text-foreground focus-visible:opacity-100",
        // Hidden on inactive tabs until hovered, as in VS Code.
        active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      <X className="size-3" aria-hidden />
    </button>
  );
}

/**
 * Keeps the active chip inside the strip's viewport. The router's scroll restoration also records
 * this scroller and writes a stale offset back after each navigation, so the reveal runs again
 * once the router has rendered.
 */
function useActiveTabVisibility(
  stripRef: RefObject<HTMLDivElement | null>,
  activeKey: string | null,
) {
  const router = useRouter();
  useEffect(() => {
    const reveal = () =>
      stripRef.current
        ?.querySelector("[data-active-tab]")
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    reveal();
    return activeKey ? router.subscribe("onRendered", reveal) : undefined;
  }, [router, stripRef, activeKey]);
}

/** A plain mouse wheel only scrolls vertically; the strip turns that into its own scroll. */
function scrollStripWithWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const linePx = event.deltaMode === event.nativeEvent.DOM_DELTA_LINE ? 16 : 1;
  event.currentTarget.scrollBy({ left: event.deltaY * linePx });
}

export function TabChipFrame({
  active,
  reviewing = false,
  divider,
  children,
  tabProps,
  className,
}: {
  active: boolean;
  reviewing?: boolean;
  divider: boolean;
  children: ReactNode;
  tabProps?: HTMLAttributes<HTMLDivElement>;
  className?: string;
}) {
  return (
    <div
      {...tabProps}
      data-active-tab={active || undefined}
      className={cn(
        // No h-full: items-stretch sizes the chip so the active tab's top margin subtracts from
        // its height. scroll-mx: scrolled into view, the active tab keeps room for its flares.
        "group w-40 shrink-0 scroll-mx-1.5 gap-1.5",
        tabChipClass(active),
        // Under review the chip takes the review strip's tone, so tab and band read as one.
        reviewing && "[--tab-chip-surface:var(--color-review)]",
        className,
      )}
    >
      {divider ? (
        <span
          aria-hidden
          className="absolute top-1/2 left-0 h-3.5 w-px -translate-y-1/2 bg-border"
        />
      ) : null}
      {children}
    </div>
  );
}
