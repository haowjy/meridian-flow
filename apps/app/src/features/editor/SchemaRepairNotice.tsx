/**
 * SchemaRepairNotice — non-blocking, session-scoped report of removed chapter prose.
 *
 * The copy button is the whole point of the notice: it is the writer's way to
 * keep words the schema could not. So it goes through the feature's clipboard
 * adapter and reports a refusal in place — a button that says nothing after a
 * blocked write has told the writer their rescued passage is safe when it is
 * still only on this screen. (`CopyTextButton` swallows refusals, so it isn't
 * used here.)
 */
import { Trans } from "@lingui/react/macro";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";

import { writeClipboardText } from "./clipboard";

const COPIED_RESET_MS = 1500;

export type SchemaRepairNoticeProps = {
  repairs: SchemaRepairEvent[];
};

export function SchemaRepairNotice({ repairs }: SchemaRepairNoticeProps) {
  const [dismissedCount, setDismissedCount] = useState(0);
  if (repairs.length <= dismissedCount) return null;

  return (
    <section data-schema-repair-notice>
      <NoticeCard
        tone="info"
        onDismiss={() => setDismissedCount(repairs.length)}
        note={
          <ol className="mt-2 flex w-full flex-col gap-2">
            {repairs.map((repair, index) => {
              // Events have no durable id; session append order and detection time
              // together identify one rendering without inventing persistence.
              const key = `${repair.detectedAt}:${index}`;
              return <RemovedFragment key={key} repair={repair} />;
            })}
          </ol>
        }
      >
        <p className="min-w-0 flex-1">
          <Trans>
            Meridian removed a small part of this chapter that this version can't display. The
            removed text is saved below so you can keep the words.
          </Trans>
        </p>
      </NoticeCard>
    </section>
  );
}

function RemovedFragment({ repair }: { repair: SchemaRepairEvent }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "blocked">("idle");
  const resetRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    [],
  );

  return (
    <li
      data-schema-repair
      data-schema-repair-phase={repair.phase}
      data-schema-repair-evidence={repair.evidenceDegraded ? "degraded" : "complete"}
      className="flex flex-col gap-1"
    >
      {repair.removedText ? (
        <>
          <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-background py-1.5 pr-1.5 pl-3">
            <pre
              data-schema-repair-removed-text
              // The rescued words, in the reader's font: wrapped and bounded so a
              // long passage scrolls inside the notice instead of pushing the page.
              className="max-h-32 min-w-0 flex-1 overflow-y-auto py-0.5 font-sans text-compact break-words whitespace-pre-wrap text-foreground"
            >
              {repair.removedText}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0"
              data-copy-schema-repair
              onClick={() => {
                void writeClipboardText(repair.removedText ?? "").then((write) => {
                  if (resetRef.current !== null) window.clearTimeout(resetRef.current);
                  resetRef.current = null;
                  if (write.status !== "done") {
                    setCopy("blocked");
                    return;
                  }
                  setCopy("copied");
                  resetRef.current = window.setTimeout(() => setCopy("idle"), COPIED_RESET_MS);
                });
              }}
            >
              {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copy === "copied" ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
            </Button>
          </div>
          {copy === "blocked" ? (
            <p role="status" data-schema-repair-copy-blocked className="text-compact">
              <Trans>
                This browser would not let the page write to the clipboard. The removed text is
                still above, so it can be selected and copied by hand.
              </Trans>
            </p>
          ) : null}
        </>
      ) : (
        <p data-schema-repair-no-text className="text-compact">
          <Trans>The removed text could not be recovered.</Trans>
        </p>
      )}
    </li>
  );
}
