/**
 * SchemaRepairNotice — non-blocking, session-scoped report of removed chapter prose.
 *
 * Deliberately unstyled.
 *
 * The copy button is the whole point of the notice: it is the writer's way to
 * keep words the schema could not. So it goes through the feature's clipboard
 * adapter and reports a refusal in place — a button that says nothing after a
 * blocked write has told the writer their rescued passage is safe when it is
 * still only on this screen.
 */
import { Trans } from "@lingui/react/macro";
import { useState } from "react";

import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";

import { writeClipboardText } from "./clipboard";

export type SchemaRepairNoticeProps = {
  repairs: SchemaRepairEvent[];
};

export function SchemaRepairNotice({ repairs }: SchemaRepairNoticeProps) {
  const [dismissedCount, setDismissedCount] = useState(0);
  /** The repair whose copy the browser refused, by the same key its row has. */
  const [blockedCopy, setBlockedCopy] = useState<string | null>(null);
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
        {repairs.map((repair, index) => {
          // Events have no durable id; session append order and detection time
          // together identify one rendering without inventing persistence.
          const key = `${repair.detectedAt}:${index}`;

          return (
            <li
              key={key}
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
                      void writeClipboardText(repair.removedText ?? "").then((write) => {
                        setBlockedCopy(write.status === "done" ? null : key);
                      });
                    }}
                  >
                    <Trans>Copy removed text</Trans>
                  </button>
                  {blockedCopy === key ? (
                    <p role="status" data-schema-repair-copy-blocked>
                      <Trans>
                        This browser would not let the page write to the clipboard. The removed text
                        is still above, so it can be selected and copied by hand.
                      </Trans>
                    </p>
                  ) : null}
                </>
              ) : (
                <p data-schema-repair-no-text>
                  <Trans>The removed text could not be recovered.</Trans>
                </p>
              )}
            </li>
          );
        })}
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
