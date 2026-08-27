/** Truthful loading, failure, and authoritative-empty recovery for Editor Work scope. */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import type { EditorWorkScope } from "./editor-work-scope";

export function EditorWorkRecovery({
  scope,
  onRetry,
  onOpenWork,
}: {
  scope: Exclude<EditorWorkScope, { status: "ready" }>;
  onRetry: () => void;
  onOpenWork: () => void;
}) {
  if (scope.status === "loading" || scope.status === "normalizing") {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <p className="text-sm text-muted-foreground">
          <Trans>Loading Work…</Trans>
        </p>
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <p className="font-medium">
          {scope.status === "empty" ? (
            <Trans>No Work yet.</Trans>
          ) : (
            <Trans>Work couldn’t load</Trans>
          )}
        </p>
        {scope.status === "empty" ? (
          <Button size="sm" variant="outline" onClick={onOpenWork}>
            <Trans>Work</Trans>
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <Trans>Retry</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
