/**
 * WorkChangesLink — "All changes in <Work>", the foot of a document's change
 * list (the identity row's popover, the phone's sheet): one route transition to
 * that Work's Files tab, where its drafts and their changes are listed. Nothing
 * for No Work, which has no Work page, and nothing while the Work's name is
 * still unknown.
 */
import { Trans } from "@lingui/react/macro";
import { ArrowRight } from "lucide-react";
import { useWorks } from "@/client/query/useWorks";
import { useOpenWork } from "@/features/project/routing/ProjectNavigationContext";
import { cn } from "@/lib/utils";

export function WorkChangesLink({
  projectId,
  workId,
  touch = false,
  onOpen,
  className,
}: {
  projectId: string;
  workId: string;
  /** The phone's link: a 44px target. */
  touch?: boolean;
  /** The writer chose to go; the list this sits in closes. */
  onOpen?: () => void;
  className?: string;
}) {
  const { works } = useWorks(projectId);
  const openWork = useOpenWork();
  const work = works?.find((candidate) => candidate.id === workId && !candidate.isNoWork);
  if (!work || !openWork) return null;
  const name = work.name;
  return (
    <button
      type="button"
      onClick={() => {
        void openWork({ kind: "work-detail", workId: work.id, view: "files" }, { replace: false });
        onOpen?.();
      }}
      className={cn(
        "focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground motion-reduce:transition-none",
        touch && "min-h-11 text-sm",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        <Trans>All changes in {name}</Trans>
      </span>
      <ArrowRight aria-hidden className="size-3.5 shrink-0" />
    </button>
  );
}
