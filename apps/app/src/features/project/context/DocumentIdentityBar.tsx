/** DocumentIdentityBar — the universal breadcrumb band at the top of the active tab's canvas. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { projectResourceNeedsRepair } from "@meridian/resource-replica";
import { FolderDown, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { ContextTab } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { escapeCssIdent } from "@/lib/css-selector";
import { cn } from "@/lib/utils";
import { useAccountResourceProjection } from "./account-feature-context";
import { schemeIcon, schemeLabel } from "./context-schemes";
import { IdentityPlacementField } from "./IdentityPlacementField";
import { IDENTITY_BAR_BAND_CLASS, IDENTITY_BAR_BOX_CLASS } from "./identity-bar-geometry";
import { type TabLocation, tabLocation } from "./identity-location";
import {
  type IdentityCommitOwnership,
  type IdentityCommitted,
  useIdentityCommit,
} from "./use-identity-commit";

export type DocumentIdentityBarProps = {
  projectId: string;
  editorWorkId: string | null;
  tab: ContextTab;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
};

export function DocumentIdentityBar({
  projectId,
  editorWorkId,
  tab,
  onCommitted,
  onOpenExisting,
}: DocumentIdentityBarProps) {
  const location = tabLocation(tab);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [dismissedRepairId, setDismissedRepairId] = useState<string | null>(null);
  const commit = useIdentityCommit({
    projectId,
    tab,
    editorWorkId: editorWorkId,
    onCommitted,
  });

  // A queued placement that failed after this document materialized reopens
  // the field with the writer's name restored and the failure's recovery
  // note — the receipt must never be dropped silently.
  const { records } = useAccountResourceProjection(projectId);
  const resource = records.find(({ resource }) =>
    tab.resourceHandle
      ? resource.handle === tab.resourceHandle
      : resource.identity.documentId === tab.documentId,
  );
  const repair = resource ? projectResourceNeedsRepair(projectId, resource) : null;
  const identityFailure =
    repair?.kind === "set-location" && repair.intentId !== dismissedRepairId
      ? ({ kind: "error", name: repair.name } as const)
      : null;
  useEffect(() => {
    if (identityFailure) setFieldOpen(true);
  }, [identityFailure]);

  // The chip always opens the one inline field when moving the document is
  // legal. Uploads aren't writing material, so those show no chip.
  const showChip = location.scheme !== "uploads";

  return (
    <div className="@container shrink-0">
      {/* Fixed-height band, full pane width. The bar is navigation chrome
          like the tab strip above it — it spans edge to edge, NOT the prose
          column. Geometry contract lives in identity-bar-geometry.ts: same
          height at rest and in edit mode, so the toolbar and prose below
          never shift when the bar transforms. Crumb text is text-sm to match
          the suggestion-popover rows it sits beside. */}
      <div
        className={cn(
          "flex items-center gap-1 px-4 font-mono text-ink-subtle text-sm",
          IDENTITY_BAR_BAND_CLASS,
        )}
      >
        {fieldOpen ? (
          <IdentityPlacementField
            projectId={projectId}
            editorWorkId={editorWorkId}
            tab={tab}
            location={location}
            failure={identityFailure}
            commit={commit}
            onExit={(reason) => {
              // Leaving the field acknowledges any failure receipt — it must
              // not reopen the editor it just closed.
              setFieldOpen(false);
              if (repair?.kind === "set-location") setDismissedRepairId(repair.intentId);
              if (reason === "escape") focusEditorProse(tab.documentId);
            }}
            onOpenExisting={onOpenExisting}
          />
        ) : (
          <IdentityPath location={location} />
        )}
        <span className="min-w-1 flex-1" />
        <DraftReviewChip documentId={tab.documentId} />
        <IdentityChipSlot
          projectId={projectId}
          tab={tab}
          location={location}
          show={showChip && !fieldOpen}
          onChooseHome={() => {
            setFieldOpen(true);
          }}
        />
      </div>
    </div>
  );
}

function IdentityPath({ location }: { location: TabLocation }) {
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
  return <span className="flex min-w-0 items-center gap-1">{segments}</span>;
}

/** Chip slot at the bar's right edge. */
function IdentityChipSlot({
  projectId,
  tab,
  location,
  show,
  onChooseHome,
}: {
  projectId: string;
  tab: ContextTab;
  location: TabLocation;
  show: boolean;
  onChooseHome: () => void;
}) {
  const deviceOnly = useDeviceOnly(projectId, tab);
  if (!deviceOnly && !show) return null;
  return (
    <>
      {deviceOnly ? <DeviceOnlyChip /> : null}
      {show ? <HomeChip provisional={location.provisional} onClick={onChooseHome} /> : null}
    </>
  );
}

const chipClass = cn(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-medium font-sans text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
  IDENTITY_BAR_BOX_CLASS,
);

/** The permanent re-home affordance (D4), whose label graduates with the
 *  document: jade "Choose a home" while provisional (an invitation), quiet
 *  outline "Rename" once homed (a tool — rename is the common case; folder
 *  browsing in the same field keeps move discoverable). Same geometry in both states. */
function HomeChip({ provisional, onClick }: { provisional: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          key={provisional ? "invite" : "quiet"}
          type="button"
          onClick={onClick}
          className={cn(
            "focus-ring",
            chipClass,
            provisional
              ? "border-primary/30 bg-primary/10 text-jade-text"
              : "border-border bg-transparent text-ink-subtle",
          )}
        >
          <FolderDown aria-hidden className="size-3" />
          <span className="@max-md:hidden">
            {provisional ? <Trans>Choose a home</Trans> : <Trans>Rename</Trans>}
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
          <Trans>Rename this document or move it somewhere else in your project.</Trans>
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
          <TriangleAlert aria-hidden className="size-3" />
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

/** Device-only with a 2s sustained grace: the warning only claims the slot once unsynced words have persisted for 2 seconds, so a normal quick materialization never flashes warning.... */
function useDeviceOnly(projectId: string, tab: ContextTab): boolean {
  const { records } = useAccountResourceProjection(projectId);
  const resource = records.find(({ resource }) =>
    tab.kind === "new"
      ? resource.handle === tab.resourceHandle
      : resource.identity.documentId === tab.documentId,
  )?.resource;
  const since = resource?.obligations.createEligibility?.eligibleAt ?? null;
  const pending =
    resource?.lifecycle.kind === "local" || Boolean(resource?.obligations.sessionAdoption);
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!pending || since === null) {
      setSustained(false);
      return;
    }
    const remaining = DEVICE_ONLY_GRACE_MS - (Date.now() - since);
    if (remaining <= 0) {
      setSustained(true);
      return;
    }
    setSustained(false);
    const timer = window.setTimeout(() => setSustained(true), remaining);
    return () => window.clearTimeout(timer);
  }, [pending, since, tab.documentId]);
  return sustained;
}

/** Esc hands focus back to the prose (the bar is one tab stop). */
function focusEditorProse(documentId: string) {
  document
    .querySelector<HTMLElement>(
      `[data-context-editor-document-id="${escapeCssIdent(documentId)}"] [contenteditable="true"]`,
    )
    ?.focus();
}
