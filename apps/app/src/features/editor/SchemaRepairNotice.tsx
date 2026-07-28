/**
 * SchemaRepairNotice — non-blocking, session-scoped report of removed chapter prose.
 *
 * Deliberately unstyled.
 */
import { Trans } from "@lingui/react/macro";
import { useState } from "react";

import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";

export type SchemaRepairNoticeProps = {
  repairs: SchemaRepairEvent[];
};

export function SchemaRepairNotice({ repairs }: SchemaRepairNoticeProps) {
  const [dismissedCount, setDismissedCount] = useState(0);
  if (repairs.length <= dismissedCount) return null;

  return (
    <section data-schema-repair-notice>
      <p>
        <Trans>
          Meridian removed a small part of this chapter that this version can't display. The removed
          text is saved below so you can keep the words.
        </Trans>
      </p>
      <ol>
        {repairs.map((repair, index) => (
          <li
            // Events have no durable id; session append order and detection time
            // together identify one rendering without inventing persistence.
            key={`${repair.detectedAt}:${index}`}
            data-schema-repair
            data-schema-repair-phase={repair.phase}
            data-schema-repair-evidence={repair.evidenceDegraded ? "degraded" : "complete"}
          >
            {repair.removedText ? (
              <>
                <pre data-schema-repair-removed-text>{repair.removedText}</pre>
                <button
                  type="button"
                  data-copy-schema-repair
                  onClick={() => {
                    void navigator.clipboard.writeText(repair.removedText ?? "");
                  }}
                >
                  <Trans>Copy removed text</Trans>
                </button>
              </>
            ) : (
              <p data-schema-repair-no-text>
                <Trans>The removed text could not be recovered.</Trans>
              </p>
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        data-dismiss-schema-repairs
        onClick={() => setDismissedCount(repairs.length)}
      >
        <Trans>Dismiss</Trans>
      </button>
    </section>
  );
}
