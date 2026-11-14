/**
 * The one line an archived or deleted Work shows wherever the writer meets it, with the way
 * back (Unarchive, Restore): a bordered box on the Work page and over one of its files in the
 * Editor, and a strip on the top edge of a chat's composer (the chat supplies the strip's frame;
 * the composer below it stays live). The way back shows at once; a refusal returns the Work and,
 * off the Work's own page (which shows its failures under its title), the failure appears here.
 */
import { Trans } from "@lingui/react/macro";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { Archive, Trash2 } from "lucide-react";
import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-command-store";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkCommandFailureRow } from "./WorkCommandFailureRow";

const WAYS_BACK = ["unarchive", "restore"] as const;

/** Unarchive or Restore, whichever brings this ended Work back. */
export function useBringWorkBack(projectId: string) {
  const { unarchive, restore } = useWorkMutations(projectId);
  return (work: Work) =>
    workLifecycleState(work) === "deleted"
      ? restore({ workId: work.id })
      : unarchive({ workId: work.id });
}

export function EndedWorkNotice({
  projectId,
  work,
  variant = "box",
  showFailure = true,
  className,
}: {
  projectId: string;
  work: Work;
  /** `strip` sits inside the frame a chat puts on its composer's top edge. */
  variant?: "box" | "strip";
  /** The Work's own page shows a refused Unarchive itself. */
  showFailure?: boolean;
  className?: string;
}) {
  const bringBack = useBringWorkBack(projectId);
  const failure = useWorkCommandFailures(projectId, WAYS_BACK).get(work.id);
  const strip = variant === "strip";
  const deleted = workLifecycleState(work) === "deleted";
  const Icon = deleted ? Trash2 : Archive;
  const sentence = deleted ? (
    <Trans>This Work is deleted.</Trans>
  ) : (
    <Trans>This Work is archived.</Trans>
  );
  const action = deleted ? <Trans>Restore</Trans> : <Trans>Unarchive</Trans>;
  return (
    <div className={cn("min-w-0", className)}>
      {strip ? (
        <div
          role="status"
          className="flex min-h-8 min-w-0 items-center gap-[var(--chat-space-inline)] py-0.5 pr-1 pl-[var(--chat-card-pad-x)] text-xs"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-muted-foreground">{sentence}</p>
          <Button
            size="xs"
            variant="quiet"
            onClick={() => void bringBack(work)}
            className="shrink-0"
          >
            {action}
          </Button>
        </div>
      ) : (
        <DocumentNotice
          icon={<Icon className="size-4" aria-hidden />}
          action={
            <Button size="sm" variant="outline" onClick={() => void bringBack(work)}>
              {action}
            </Button>
          }
        >
          {sentence}
        </DocumentNotice>
      )}
      {showFailure && failure ? (
        <div className={strip ? "px-[var(--chat-card-pad-x)] pb-2" : "pt-2"}>
          <WorkCommandFailureRow failure={failure} />
        </div>
      ) : null}
    </div>
  );
}
