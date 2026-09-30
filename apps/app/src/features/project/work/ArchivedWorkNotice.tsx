/**
 * The one line an archived Work shows wherever the writer meets it (the Work
 * page, a chat's composer slot, one of its files in the Editor), with Unarchive.
 * Unarchive shows at once; a refusal returns the Work and, off the Work page
 * where the band carries it, the failure appears here.
 */
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { Archive } from "lucide-react";
import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import { WorkCommandFailureRow } from "./WorkCommandFailureRow";

const UNARCHIVE = ["unarchive"] as const;

export function ArchivedWorkNotice({
  projectId,
  work,
  showFailure = true,
  className,
}: {
  projectId: string;
  work: Work;
  /** The Work page's band already carries a refused Unarchive. */
  showFailure?: boolean;
  className?: string;
}) {
  const toggleArchive = useWorkArchiveToggle(projectId);
  const failure = useWorkCommandFailures(projectId, UNARCHIVE).get(work.id);
  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="status"
        className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-card py-1.5 pr-1.5 pl-3"
      >
        <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          <Trans>This Work is archived.</Trans>
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void toggleArchive(work)}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        >
          <Trans>Unarchive</Trans>
        </Button>
      </div>
      {showFailure && failure ? (
        <div className="pt-2">
          <WorkCommandFailureRow failure={failure} />
        </div>
      ) : null}
    </div>
  );
}
