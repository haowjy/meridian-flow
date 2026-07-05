/**
 * ResultsRailSection — collapsible section in the Context rail that lists
 * promoted artifacts ("Results") for the active project, with type icon,
 * agent attribution, and a click-through to the producing thread.
 *
 * Replaces the previous `ComingSoonSection` placeholder. Visual language
 * intentionally matches the sibling sections (Uploads / Recent) so the rail
 * reads as one IA. The row composition is its own primitive because results
 * carry attribution + a click affordance that the document sections don't.
 *
 * Anchor situation: producing-turn anchors are not yet supported by the
 * chat view (only `data-turn-id` exists at the DOM level; there is no
 * router-driven scroll-to-turn). The row's click-through therefore
 * navigates to the producing thread only and relies on top-of-thread
 * landing for now. The producing `turnId` rides along on the navigation
 * search param so a future deep-link layer can pick it up without a
 * protocol change.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { FileImage, FileSpreadsheet, FileText, type LucideIcon, Sparkles } from "lucide-react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { useProjectAgents } from "@/client/query/useProjectAgents";
import { useProjectResults } from "@/client/query/useProjectResults";
import { Badge } from "@/components/ui/badge";
import { resolveAgentFromCatalog } from "@/features/agents/resolve-agent";
import { relativeTime } from "@/features/project/relative-time";
import { CollapsibleRailSection, RailEmptyHint, RailErrorRow, RailKindIcon } from "./RailSection";

export type ResultsRailSectionProps = {
  projectId: string | null;
  /** Called when the user opens a result in the rail viewer overlay. */
  onOpenResult: (result: ProjectResultItem) => void;
};

export type ResultsRailModel = {
  status: ReturnType<typeof useProjectResults>;
  /** `null` hides the count while loading/error/disabled. */
  count: number | null;
};

export function useResultsRailModel(projectId: string | null): ResultsRailModel {
  const status = useProjectResults(projectId);
  // Count visibility follows the same honest rule as the sibling sections:
  // only render in `ready`/`empty` so we never fabricate `0` over the top of
  // a hint that says "couldn't load".
  const count =
    status.status === "ready" || status.status === "empty" ? (status.results?.length ?? 0) : null;
  return { status, count };
}

export function ResultsRailBody({
  projectId,
  model,
  onOpenResult,
}: {
  projectId: string | null;
  model: ResultsRailModel;
  onOpenResult: (result: ProjectResultItem) => void;
}) {
  const { status } = model;
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-0.5">
      {status.status === "disabled" ? (
        <RailEmptyHint>
          <Trans>Open a project to see its results.</Trans>
        </RailEmptyHint>
      ) : status.status === "loading" ? (
        <RailEmptyHint>
          <Trans>Loading results…</Trans>
        </RailEmptyHint>
      ) : status.status === "error" ? (
        <RailErrorRow onRetry={status.refetch} />
      ) : status.status === "empty" || !status.results || status.results.length === 0 ? (
        <RailEmptyHint>
          <Trans>No results yet.</Trans>
        </RailEmptyHint>
      ) : (
        <ul className="flex flex-col">
          {status.results.map((result) => (
            <ResultRow
              key={result.id}
              projectId={projectId}
              result={result}
              onOpen={() => onOpenResult(result)}
              onOpenProducingThread={() => {
                // Navigate to the producing thread. The chat view doesn't
                // currently support an in-thread turn anchor (only DOM-level
                // `data-turn-id` exists; no router-driven scroll-to-turn),
                // so we land at the top of the thread for now. The
                // producing `turnId` is intentionally not carried in
                // routing state — there is no consumer yet, and adding it
                // would create a dangling URL surface to keep clean.
                void navigate({
                  to: "/chat/$threadId",
                  params: { threadId: result.threadId },
                });
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function ResultsRailSection({ projectId, onOpenResult }: ResultsRailSectionProps) {
  const model = useResultsRailModel(projectId);

  return (
    <CollapsibleRailSection
      title={t`Results`}
      icon={<Sparkles className="size-3.5" />}
      count={model.count}
      defaultOpen
    >
      <ResultsRailBody projectId={projectId} model={model} onOpenResult={onOpenResult} />
    </CollapsibleRailSection>
  );
}

/* ── Row primitives ──────────────────────────────────────────────────── *
 *
 * Image rows render a `FileImage` mime icon rather than a true thumbnail
 * preview. Preloading thumbnails would fire one signed-URL request per
 * image row on rail open (and expire on every list refetch) — that's
 * expensive for a rail that may show dozens of plots. Real image
 * thumbnails belong to a future cached/long-lived preview surface; the
 * mime icon is honest about the kind without that cost.
 */

function ResultRow({
  projectId,
  result,
  onOpen,
  onOpenProducingThread,
}: {
  projectId: string | null;
  result: ProjectResultItem;
  onOpen: () => void;
  onOpenProducingThread: () => void;
}) {
  const name = displayName(result);
  const catalog = useProjectAgents(projectId);
  const agent = resolveAgentFromCatalog(result.agentSlug, catalog.agents);
  return (
    <li>
      <div
        className="group flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
        title={result.workspacePath}
      >
        <button
          type="button"
          onClick={onOpen}
          className="focus-ring flex min-w-0 flex-1 items-start gap-2 rounded text-left"
          aria-label={t`Open result ${name}`}
        >
          <KindIcon mimeType={result.mimeType} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{name}</span>
            <span className="truncate text-meta text-muted-foreground">
              {formatResultDetail(result)}
            </span>
          </span>
        </button>
        {/* Provenance: producing agent + click-through to producing thread. */}
        <button
          type="button"
          onClick={onOpenProducingThread}
          className="focus-ring shrink-0"
          aria-label={t`Open producing turn in ${agent.name}`}
          title={t`Open producing turn`}
        >
          <Badge variant="neutral" className="max-w-[8rem] min-w-0 font-medium">
            <span className="min-w-0 truncate">{agent.name}</span>
          </Badge>
        </button>
      </div>
    </li>
  );
}

function KindIcon({ mimeType }: { mimeType: string }) {
  const { Icon, tone } = pickIconForMime(mimeType);
  return (
    <RailKindIcon tone={tone}>
      <Icon className="size-3.5" />
    </RailKindIcon>
  );
}

/* ── Pure helpers ─────────────────────────────────────────────────────
 *
 * Exported for the unit test — display name parsing has to survive both
 * `/project workspace/path.ext` and bare URI shapes (`work://<workId>/results/foo.ext`),
 * so it gets its own test alongside the rail render.
 */

export function displayName(result: ProjectResultItem): string {
  // Prefer the project workspace path's basename; the resultsUri may carry a longer
  // prefix that's noisier in the rail. Falls back to the URI tail.
  const path = result.workspacePath || result.resultsUri || "result";
  const tail = path.split("/").filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : "result";
}

export function pickIconForMime(mimeType: string): { Icon: LucideIcon; tone: string } {
  if (mimeType.startsWith("image/")) return { Icon: FileImage, tone: "text-status-streaming" };
  if (mimeType === "application/pdf") return { Icon: FileText, tone: "text-destructive" };
  if (
    mimeType === "text/csv" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return { Icon: FileSpreadsheet, tone: "text-accent" };
  }
  return { Icon: FileText, tone: "text-primary" };
}

function formatResultDetail(result: ProjectResultItem): string {
  const size = formatBytes(result.sizeBytes);
  const when = relativeTime(result.createdAt, Date.now());
  return [size, when].filter(Boolean).join(" · ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
