/** The Results list: tree-style rows, shared by the desktop rail and the phone Results view. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileImage, FileSpreadsheet, FileText, type LucideIcon } from "lucide-react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { useProjectResults } from "@/client/query/useProjectResults";
import { Badge } from "@/components/ui/badge";
import { requestConversationReveal } from "@/features/chat/conversation-reveal";
import { relativeTime } from "@/features/project/relative-time";
import { RailEmptyHint, RailErrorRow, RailFileRow } from "../shell/RailSection";

export type ResultsListModel = {
  status: ReturnType<typeof useProjectResults>;
};

export function useResultsListModel(projectId: string | null): ResultsListModel {
  return { status: useProjectResults(projectId) };
}

export function ResultsList({
  model,
  onOpenResult,
}: {
  projectId: string | null;
  model: ResultsListModel;
  onOpenResult: (result: ProjectResultItem) => void;
}) {
  const { status } = model;

  return (
    <div>
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
              result={result}
              onOpen={() => onOpenResult(result)}
              onOpenProducingThread={() =>
                // The turn is the target; a result has no change row inside it.
                requestConversationReveal({
                  kind: "turn",
                  threadId: result.threadId,
                  turnId: result.turnId,
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/* Image rows render a `FileImage` mime icon rather than a true thumbnail
 * preview. Preloading thumbnails would fire one signed-URL request per
 * image row on rail open (and expire on every list refetch) — that's
 * expensive for a rail that may show dozens of plots. Real image
 * thumbnails belong to a future cached/long-lived preview surface; the
 * mime icon is honest about the kind without that cost.
 */

function ResultRow({
  result,
  onOpen,
  onOpenProducingThread,
}: {
  result: ProjectResultItem;
  onOpen: () => void;
  onOpenProducingThread: () => void;
}) {
  const name = displayName(result);
  const agentName = result.agentName;
  const when = relativeTime(result.createdAt, Date.now());
  return (
    <li>
      <RailFileRow
        icon={pickIconForMime(result.mimeType).Icon}
        name={name}
        title={when ? `${result.workspacePath} (${when})` : result.workspacePath}
        ariaLabel={t`Open result ${name}`}
        onOpen={onOpen}
        // The producing-agent badge reveals its thread; it does not open result content.
        trailing={
          <button
            type="button"
            onClick={onOpenProducingThread}
            className="focus-ring shrink-0"
            aria-label={t`Open producing turn in ${agentName}`}
            title={t`Open producing turn`}
          >
            <Badge variant="neutral" className="max-w-[8rem] min-w-0 font-medium">
              <span className="min-w-0 truncate">{agentName}</span>
            </Badge>
          </button>
        }
      />
    </li>
  );
}

/* Result names must handle both `/project workspace/path.ext` and bare URI
 * shapes (`work://<workId>/results/foo.ext`).
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
