/** Shared presentation for independently failing Work-detail resources. */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";

export function WorkResourceError({ label, retry }: { label: string; retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3">
      <p className="text-sm text-destructive">
        {label} <Trans>couldn’t load</Trans>
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={retry}
        className="[@media(pointer:coarse)]:min-h-11"
      >
        <Trans>Retry</Trans> {label}
      </Button>
    </div>
  );
}
