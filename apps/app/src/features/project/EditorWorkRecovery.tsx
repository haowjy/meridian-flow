/** Truthful loading and failure while the Work scope's catalog has not answered. */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";

export function EditorWorkRecovery({
  status,
  onRetry,
}: {
  status: "loading" | "error";
  onRetry: () => void;
}) {
  if (status === "loading") {
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
          <Trans>Work couldn’t load</Trans>
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    </div>
  );
}
