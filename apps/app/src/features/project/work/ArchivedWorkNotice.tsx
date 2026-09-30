/**
 * The one line an archived Work shows wherever the writer meets it, with
 * Unarchive: a bordered box on the Work page and over one of its files in the
 * Editor, and a strip on the top edge of a chat's composer (the chat supplies
 * the strip's frame; the composer below it stays live).
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
  variant = "box",
  showFailure = true,
  className,
}: {
  projectId: string;
  work: Work;
  /** `strip` sits inside the frame a chat puts on its composer's top edge. */
  variant?: "box" | "strip";
  /** The Work page's band already carries a refused Unarchive. */
  showFailure?: boolean;
  className?: string;
}) {
  const toggleArchive = useWorkArchiveToggle(projectId);
  const failure = useWorkCommandFailures(projectId, UNARCHIVE).get(work.id);
  const strip = variant === "strip";
  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="status"
        className={cn(
          "flex min-w-0 items-center",
          strip
            ? "min-h-8 gap-[var(--chat-space-inline)] py-0.5 pr-1 pl-[var(--chat-card-pad-x)] text-caption"
            : "gap-3 rounded-lg border border-border-subtle bg-card py-1.5 pr-1.5 pl-3 text-sm",
        )}
      >
        <Archive
          className={cn("shrink-0 text-muted-foreground", strip ? "size-3.5" : "size-4")}
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-muted-foreground">
          <Trans>This Work is archived.</Trans>
        </p>
        <Button
          size={strip ? "xs" : "sm"}
          variant={strip ? "quiet" : "outline"}
          onClick={() => void toggleArchive(work)}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        >
          <Trans>Unarchive</Trans>
        </Button>
      </div>
      {showFailure && failure ? (
        <div className={strip ? "px-[var(--chat-card-pad-x)] pb-2" : "pt-2"}>
          <WorkCommandFailureRow failure={failure} />
        </div>
      ) : null}
    </div>
  );
}
