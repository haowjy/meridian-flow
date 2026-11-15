/**
 * The one app-wide "not sent yet" mark: shown while something the writer did has gone unanswered
 * for a while, or the browser is offline with something waiting. The shell places it in the
 * trailing area of the band it already has (main's header on desktop, the phone top bar), so it
 * takes room the band already has, changes the height of nothing and covers no control; nothing
 * else marks an unsent change.
 */
import { t } from "@lingui/core/macro";
import { CloudOff } from "lucide-react";
import { useDriverSnapshot } from "@/client/commands/driver-context";

export function NotSentYet() {
  const { notSent, paused } = useDriverSnapshot();
  if (!notSent) return null;
  return (
    <span
      role="status"
      title={
        paused
          ? t`You’re signed out of this account. Sign in again and the changes will be sent.`
          : t`Changes are waiting to be sent. They go out on their own.`
      }
      className="flex shrink-0 items-center gap-1 self-center px-1.5 text-xs text-muted-foreground"
    >
      <CloudOff className="size-3" aria-hidden />
      {paused ? t`Not sent, signed out` : t`Not sent`}
    </span>
  );
}
