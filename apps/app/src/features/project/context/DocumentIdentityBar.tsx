/**
 * DocumentIdentityBar — the universal breadcrumb band at the top of the
 * active tab's canvas. One quiet mono path (`Scratch › Untitled 4`) on every
 * document; provisional docs are a *state* of the bar (italic leaf + jade
 * chip), not separate chrome.
 *
 * Two affordances, two grammars:
 * - **Click the path to type.** Provisional docs open the placement field
 *   (name + destination browser from the scheme roots); homed docs open the
 *   full-path field with the clicked segment selected (typed-path move).
 * - **Click the chip to browse.** "Choose a home" is permanent: jade on
 *   provisional docs (opens placement), quiet outline once homed (opens the
 *   Move-to popup). Device-only words outrank it in the same slot.
 *
 * Keystroke-path contract: at rest the bar renders from tab metadata only.
 * Content observers mount only while a field is open on a provisional doc.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FolderDown, TriangleAlert } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";

import type { ContextTab } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { schemeIcon, schemeLabel } from "./context-schemes";
import { IdentityMovePopup } from "./IdentityMovePopup";
import { type IdentityFieldMode, IdentityPathField } from "./IdentityPathField";
import { type TabLocation, tabLocation } from "./identity-location";
import {
  clearQueuedRenameFailure,
  useQueuedRenameFailure,
  useUntitledPendingSince,
} from "./untitled-reconciler";
import { type IdentityCommitted, useIdentityCommit } from "./use-identity-commit";

export type DocumentIdentityBarProps = {
  projectId: string;
  activeThreadId: string | null;
  defaultWorkId: string | null;
  tab: ContextTab;
  onCommitted: (documentId: string, next: IdentityCommitted) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
};

type Surface = { kind: "field"; mode: IdentityFieldMode } | { kind: "popup" } | null;

export function DocumentIdentityBar({
  projectId,
  activeThreadId,
  defaultWorkId,
  tab,
  onCommitted,
  onOpenExisting,
}: DocumentIdentityBarProps) {
  const location = tabLocation(tab);
  const [surface, setSurface] = useState<Surface>(null);
  const commit = useIdentityCommit({ projectId, tab, defaultWorkId, onCommitted });

  // Placement happens once: only an untitled doc that was never explicitly
  // renamed or homed (provisional, still at its default Scratch root) opens
  // the empty placement field. Any explicit save graduates it to the path
  // grammar permanently.
  const placementGrammar =
    location.provisional && location.scheme === "scratch" && location.parentPath === "/";

  // A queued placement that failed after this document materialized reopens
  // the field with the writer's name restored and the failure's recovery
  // note — the receipt must never be dropped silently.
  const renameFailure = useQueuedRenameFailure(tab.documentId);
  useEffect(() => {
    if (!renameFailure) return;
    setSurface({ kind: "field", mode: { kind: "placement" } });
  }, [renameFailure]);

  const openField = (mode: IdentityFieldMode) => {
    if (location.editable) setSurface({ kind: "field", mode });
  };
  const openTyping = (segment: number | "leaf") => {
    openField(placementGrammar ? { kind: "placement" } : { kind: "path", initialSegment: segment });
  };

  // The chip is the pointing surface: placement while never-placed, the
  // Move-to popup once placed. Viewer docs get the popup too when moving them
  // is legal; uploads aren't writing material, so those show no chip.
  const chipOpensPopup = !placementGrammar && location.scheme !== "uploads";
  const showChip = location.editable || chipOpensPopup;

  return (
    <div className="@container shrink-0">
      {/* Fixed 22px band, full pane width. The bar is navigation chrome like
          the tab strip above it — it spans edge to edge, NOT the prose
          column. The height is identical at rest and in edit mode (children
          are h-4.5 boxes in an 18px content area), so the toolbar and prose
          below never shift when the bar transforms. */}
      <div className="flex h-5.5 items-center gap-1 px-4 pt-1 font-mono text-ink-subtle text-meta">
        {surface?.kind === "field" ? (
          <IdentityPathField
            key={surface.mode.kind}
            projectId={projectId}
            activeThreadId={activeThreadId}
            defaultWorkId={defaultWorkId}
            tab={tab}
            location={location}
            mode={surface.mode}
            failure={renameFailure}
            commit={commit}
            onExit={(reason) => {
              // Leaving the field acknowledges any failure receipt — it must
              // not reopen the editor it just closed.
              clearQueuedRenameFailure(tab.documentId);
              setSurface(null);
              if (reason === "escape") focusEditorProse(tab.documentId);
            }}
            onOpenExisting={onOpenExisting}
          />
        ) : (
          <IdentityPath
            location={location}
            onEdit={openTyping}
            onEscape={() => focusEditorProse(tab.documentId)}
          />
        )}
        <span className="min-w-1 flex-1" />
        <IdentityChipSlot
          documentId={tab.documentId}
          location={location}
          show={showChip && surface?.kind !== "field"}
          popup={
            chipOpensPopup
              ? {
                  open: surface?.kind === "popup",
                  onOpenChange: (open) => setSurface(open ? { kind: "popup" } : null),
                  projectId,
                  activeThreadId,
                  defaultWorkId,
                  commit,
                  onOpenExisting,
                }
              : null
          }
          onChooseHome={() => {
            if (chipOpensPopup) setSurface({ kind: "popup" });
            else openField({ kind: "placement" });
          }}
        />
      </div>
    </div>
  );
}

/** Rest state: the quiet crumb row. Middle folders collapse to `…`; narrow
 *  containers drop the scheme label (glyph only) and folder names. Clicking a
 *  segment opens the typed field with that segment selected. */
function IdentityPath({
  location,
  onEdit,
  onEscape,
}: {
  location: TabLocation;
  onEdit: (segment: number | "leaf") => void;
  onEscape: () => void;
}) {
  const SchemeIcon = schemeIcon(location.scheme);
  const separator = (
    <span aria-hidden className="shrink-0 opacity-60">
      ›
    </span>
  );
  const lastFolderIndex = location.folders.length;
  const segments = (
    <>
      <span data-seg="0" className="flex shrink-0 items-center gap-1">
        <SchemeIcon aria-hidden className="size-3 shrink-0" />
        <span className="@max-md:hidden">{schemeLabel(location.scheme)}</span>
      </span>
      {location.folders.length > 0 ? (
        <>
          {separator}
          <span className="flex min-w-0 items-center gap-1 @max-md:hidden">
            {location.folders.length > 1 ? (
              <>
                <span aria-hidden data-seg="1">
                  …
                </span>
                {separator}
              </>
            ) : null}
            <span data-seg={lastFolderIndex} className="truncate">
              {location.folders[location.folders.length - 1]}
            </span>
          </span>
          <span aria-hidden data-seg="1" className="hidden @max-md:inline">
            …
          </span>
        </>
      ) : null}
      {separator}
      <span
        data-seg="leaf"
        className={cn("truncate text-ink-muted", location.provisional && "italic")}
      >
        {location.leaf}
      </span>
    </>
  );
  if (!location.editable) {
    return <span className="flex min-w-0 items-center gap-1">{segments}</span>;
  }
  const segmentFromClick = (event: MouseEvent<HTMLButtonElement>): number | "leaf" => {
    const raw = (event.target as HTMLElement).closest("[data-seg]")?.getAttribute("data-seg");
    if (raw === "leaf" || raw === null || raw === undefined) return "leaf";
    const index = Number(raw);
    return Number.isNaN(index) ? "leaf" : index;
  };
  return (
    <button
      type="button"
      onClick={(event) => onEdit(segmentFromClick(event))}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape();
      }}
      aria-label={t`Document name and location`}
      className="focus-ring flex min-w-0 cursor-text items-center gap-1 rounded-sm text-left"
    >
      {segments}
    </button>
  );
}

/**
 * Single-occupancy chip slot at the bar's right edge. Severity ladder:
 * device-only words (warning tokens, 2s sustained grace) outrank the
 * permanent "Choose a home" chip — jade while provisional (an invitation),
 * quiet outline once homed (a tool).
 */
function IdentityChipSlot({
  documentId,
  location,
  show,
  popup,
  onChooseHome,
}: {
  documentId: string;
  location: TabLocation;
  show: boolean;
  popup: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
    activeThreadId: string | null;
    defaultWorkId: string | null;
    commit: Parameters<typeof IdentityMovePopup>[0]["commit"];
    onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
  } | null;
  onChooseHome: () => void;
}) {
  const deviceOnly = useDeviceOnly(documentId);
  if (deviceOnly) return <DeviceOnlyChip />;
  if (!show) return null;
  const chip = <HomeChip provisional={location.provisional} onClick={onChooseHome} />;
  if (!popup) return chip;
  return (
    <IdentityMovePopup
      projectId={popup.projectId}
      activeThreadId={popup.activeThreadId}
      defaultWorkId={popup.defaultWorkId}
      location={location}
      open={popup.open}
      onOpenChange={popup.onOpenChange}
      commit={popup.commit}
      onOpenExisting={popup.onOpenExisting}
      trigger={chip}
    />
  );
}

const chipClass =
  "inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-medium font-sans text-meta motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150";

/** "Choose a home" — the permanent re-home affordance (D4). Same label, same
 *  geometry in both states; one token swap between invitation and tool. */
function HomeChip({ provisional, onClick }: { provisional: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          key={provisional ? "invite" : "quiet"}
          type="button"
          onClick={onClick}
          className={cn(
            "focus-ring cursor-pointer",
            chipClass,
            provisional
              ? "border-primary/30 bg-primary/10 text-jade-text"
              : "border-border bg-transparent text-ink-subtle",
          )}
        >
          <FolderDown aria-hidden className="size-2.5" />
          <span className="@max-md:hidden">
            <Trans>Choose a home</Trans>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="max-w-60">
        {provisional ? (
          <Trans>
            This draft is untitled and lives in your Scratch. Click to name it or move it where it
            belongs.
          </Trans>
        ) : (
          <Trans>Move this document somewhere else in your project.</Trans>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function DeviceOnlyChip() {
  const label = t`Only on this device`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          className={cn(chipClass, "border-warning-border bg-warning-bg text-warning-foreground")}
        >
          <TriangleAlert aria-hidden className="size-2.5" />
          <span className="@max-md:hidden">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const DEVICE_ONLY_GRACE_MS = 2_000;

/**
 * Device-only with a 2s sustained grace: the warning only claims the slot
 * once unsynced words have persisted for 2 seconds, so a normal quick
 * materialization never flashes warning chrome. The clock is the
 * reconciler's per-document `pendingSince` — remounting the bar (tab
 * switches) cannot restart the window.
 */
function useDeviceOnly(documentId: string): boolean {
  const since = useUntitledPendingSince(documentId);
  const [, bump] = useState(0);
  const sustained = since !== null && Date.now() - since >= DEVICE_ONLY_GRACE_MS;
  useEffect(() => {
    if (since === null || sustained) return;
    const timer = window.setTimeout(
      () => bump((tick) => tick + 1),
      DEVICE_ONLY_GRACE_MS - (Date.now() - since),
    );
    return () => window.clearTimeout(timer);
  }, [since, sustained]);
  return sustained;
}

/** Esc hands focus back to the prose (the bar is one tab stop). */
function focusEditorProse(documentId: string) {
  document
    .querySelector<HTMLElement>(
      `[data-context-editor-document-id="${CSS.escape(documentId)}"] [contenteditable="true"]`,
    )
    ?.focus();
}
