/** Truthful loading, failure, and unavailable recovery for Editor Work scope. */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import type { EditorWorkScope } from "./editor-work-scope";

export function EditorWorkRecovery({
  scope,
  onRetry,
}: {
  scope: Exclude<EditorWorkScope, { status: "ready" }>;
  onRetry: () => void;
}) {
  if (scope.status === "loading") {
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
          {scope.status === "unavailable" ? (
            <Trans>This Work is unavailable.</Trans>
          ) : (
            <Trans>Work couldn’t load</Trans>
          )}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    </div>
  );
}
