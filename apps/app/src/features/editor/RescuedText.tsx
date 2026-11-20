/**
 * The one body for text handed back to the writer: each passage with Copy, then what happened
 * and Dismiss, so Dismiss never clears words the writer has not seen. The schema repair's bar
 * opens it under Details.
 *
 * Copy is the point: it is the writer's way to keep the words. So it goes through the feature's
 * clipboard adapter and reports a refusal on that passage. (`CopyTextButton` swallows refusals.)
 *
 * Each rescue counts once where it is first shown (`useCountRescues`), through the client
 * diagnostics channel, with its sizes and never its words.
 */
import { Trans } from "@lingui/react/macro";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFailureLog } from "@/client/failures/failure-log";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { writeClipboardText } from "./clipboard";

const COPIED_RESET_MS = 1500;

/** One rescue as diagnostics count it: its id and kind, and the passages it handed back. */
export type CountedRescue = {
  occurrenceId: string;
  rescue: { kind: "schema-removed-text" };
  passages: readonly (string | null)[];
};

/** Counts each rescue the first time it shows; the log drops an id it has already sent. */
export function useCountRescues(rescues: readonly CountedRescue[]) {
  const log = useFailureLog();
  useEffect(() => {
    for (const { occurrenceId, rescue, passages } of rescues)
      log.record({
        occurrenceId,
        phase: "rescued",
        rescue: {
          ...rescue,
          chars: passages.reduce((total, passage) => total + (passage?.length ?? 0), 0),
          passages: passages.length,
        },
      });
  }, [log, rescues]);
}

export function RescuedText({
  passages,
  note,
  onDismiss,
  onCopied,
}: {
  /** Each passage's words; null for one that couldn't be recovered. */
  passages: readonly (string | null)[];
  /** Beside Dismiss: what happened, or why. None when there are no words to say it about. */
  note: ReactNode;
  onDismiss: () => void;
  /** A passage reached the clipboard. */
  onCopied?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {passages.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {passages.map((text, index) => (
            // Passages have no identity beyond their order; a rescue's never reorder.
            <RescuedPassage key={index} text={text} onCopied={onCopied} />
          ))}
        </ol>
      ) : null}
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-muted-foreground">{note}</p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0 coarse:h-11"
          onClick={onDismiss}
        >
          <Trans>Dismiss</Trans>
        </Button>
      </div>
    </div>
  );
}

/** Copies `text`; `"copied"` shows for a moment, `"blocked"` stays until the next press. */
function useCopyText(text: string | null, onCopied?: () => void) {
  const [copy, setCopy] = useState<"idle" | "copied" | "blocked">("idle");
  const resetRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    [],
  );
  const press = () => {
    if (!text) return;
    void writeClipboardText(text).then((write) => {
      // A pending Copied reset must not erase a later refusal.
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
      resetRef.current = null;
      if (write.status !== "done") {
        setCopy("blocked");
        return;
      }
      setCopy("copied");
      onCopied?.();
      resetRef.current = window.setTimeout(() => setCopy("idle"), COPIED_RESET_MS);
    });
  };
  return { copy, press };
}

function RescuedPassage({ text, onCopied }: { text: string | null; onCopied?: () => void }) {
  const { copy, press } = useCopyText(text, onCopied);

  if (!text)
    return (
      // The same box as a rescued passage, so it reads as its own item.
      <li
        data-rescued-passage-missing
        className="rounded-md border border-border-subtle bg-background py-2 pr-1.5 pl-3 text-muted-foreground"
      >
        <Trans>This passage couldn't be recovered.</Trans>
      </li>
    );
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-background py-1.5 pr-1.5 pl-3">
        <pre
          data-rescued-passage
          // The rescued words in the reader's font, wrapped and bounded so one
          // long passage doesn't hide the rest of the list.
          className="max-h-32 min-w-0 flex-1 overflow-y-auto py-0.5 font-sans break-words whitespace-pre-wrap text-foreground"
        >
          {text}
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 coarse:h-11"
          data-copy-rescued-passage
          onClick={press}
        >
          {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copy === "copied" ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
        </Button>
      </div>
      {copy === "blocked" ? (
        <InlineErrorRow
          message={<Trans>Couldn't copy. Select the text to copy it.</Trans>}
          className="p-0"
        />
      ) : null}
    </li>
  );
}
