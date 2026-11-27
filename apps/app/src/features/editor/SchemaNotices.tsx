import { Trans } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SchemaFence } from "@/core/editor/schema-fence";

const BAR_ACTION = "shrink-0 coarse:-my-2.5 coarse:h-11";

export function SchemaNotices({ fence }: { fence: SchemaFence | null }) {
  if (!fence) return null;
  return (
    <div
      data-schema-fence=""
      data-schema-fence-reason={fence.reason}
      role="alert"
      className="flex min-h-8 items-center gap-2 rounded-md border border-destructive-border bg-destructive-tint py-1 pr-1 pl-2.5 text-xs text-destructive"
    >
      <CircleAlert aria-hidden className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">
        <Trans>Editing paused</Trans>
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={BAR_ACTION}
        onClick={() => window.location.reload()}
      >
        <Trans>Refresh</Trans>
      </Button>
    </div>
  );
}
