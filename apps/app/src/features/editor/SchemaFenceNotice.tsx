/**
 * SchemaFenceNotice — minimal writer copy for a fenced editor session.
 *
 * Deliberately unstyled.
 */
import { Trans } from "@lingui/react/macro";

import type { SchemaFence } from "@/core/editor/schema-fence";

export type SchemaFenceNoticeProps = {
  fence: SchemaFence;
};

export function SchemaFenceNotice({ fence }: SchemaFenceNoticeProps) {
  return (
    <p data-schema-fence data-schema-fence-reason={fence.reason}>
      <Trans>
        This chapter was opened in a newer version of Meridian. Refresh to keep writing.
      </Trans>
    </p>
  );
}
