/**
 * The working-set sync preference row. Lives in its own module so the
 * account-lifetime owner can be exercised with the real rendered control, not
 * just the command hook.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSharedWorkingSetSyncPreference } from "./WorkingSetSyncPreferenceProvider";

export function WorkingSetSyncPreferenceRow() {
  const router = useRouter();
  const preference = useSharedWorkingSetSyncPreference();
  const [retrying, setRetrying] = useState(false);

  async function retryUnavailable() {
    setRetrying(true);
    try {
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            <Trans>Resume where I left off on any device</Trans>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {!preference.available ? (
              <Trans>
                Your saved preference is unavailable. Sync is paused until retry succeeds.
              </Trans>
            ) : (
              <Trans>Reopens your last document and chat when you switch devices</Trans>
            )}
          </p>
        </div>
        {!preference.available ? (
          <Button
            type="button"
            variant="outline"
            disabled={retrying}
            onClick={() => void retryUnavailable()}
          >
            <Trans>Retry</Trans>
          </Button>
        ) : (
          <Switch
            checked={preference.value}
            aria-busy={preference.pending || undefined}
            onCheckedChange={preference.change}
            aria-label={t`Resume where I left off on any device`}
          />
        )}
      </div>
      {preference.available && preference.error ? (
        <InlineErrorRow
          message={
            preference.error.kind === "rejected"
              ? t`Couldn’t save this preference.`
              : t`Couldn’t confirm this preference saved.`
          }
          onRetry={preference.retry}
        />
      ) : null}
    </div>
  );
}
