/** A project still being created: a quiet line while it is on its way, Retry or Discard once refused. */
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import type { ProjectCreationState } from "@/client/query/useProjectCreation";
import { Button } from "@/components/ui/button";

export function ProjectCreationNotice({ creation }: { creation: ProjectCreationState }) {
  const router = useRouter();
  if (creation.status !== "pending" && creation.status !== "failed") return null;
  const failed = creation.status === "failed";
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-2"
      role={failed ? "alert" : "status"}
    >
      <p className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {failed ? <Trans>Project creation failed.</Trans> : <Trans>Creating project…</Trans>}
      </p>
      {failed ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={creation.retry}>
            <Trans>Retry</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              creation.discard();
              void router.navigate({ to: "/" });
            }}
          >
            <Trans>Discard</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
