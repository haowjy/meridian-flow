/**
 * SchemaFenceNotice — a fenced editor session: this tab's Meridian is older than
 * the chapter, so writing stops until the writer reloads. It's a failure of this
 * session, so it takes the error tone, and Refresh sits on the card that asks for it.
 */
import { Trans } from "@lingui/react/macro";

import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";
import type { SchemaFence } from "@/core/editor/schema-fence";

export type SchemaFenceNoticeProps = {
  fence: SchemaFence;
};

export function SchemaFenceNotice({ fence }: SchemaFenceNoticeProps) {
  return (
    <NoticeCard tone="error">
      <p className="min-w-0 flex-1" data-schema-fence data-schema-fence-reason={fence.reason}>
        <Trans>
          This chapter was opened in a newer version of Meridian. Refresh to keep writing.
        </Trans>
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => window.location.reload()}
      >
        <Trans>Refresh</Trans>
      </Button>
    </NoticeCard>
  );
}
