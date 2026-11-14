/**
 * The one app-wide "not sent yet" line: shown while something the writer did has gone
 * unanswered for a while, or the browser is offline with something waiting. It sits in the
 * sidebar's header band and adds no height; nothing else marks an unsent change.
 */
import { t } from "@lingui/core/macro";
import { CloudOff } from "lucide-react";
import { useNotSentYet } from "@/client/commands/driver-context";

export function NotSentYet() {
  const notSent = useNotSentYet();
  if (!notSent) return null;
  return (
    <span
      role="status"
      title={t`Changes are waiting to be sent. They go out on their own.`}
      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
    >
      <CloudOff className="size-3.5" aria-hidden />
      {t`Not sent`}
    </span>
  );
}
