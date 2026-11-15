/**
 * The one app-wide "not sent yet" line: shown while something the writer did has gone
 * unanswered for a while, or the browser is offline with something waiting. It is a fixed line
 * on the top edge, so it shows on every layout (sidebar open or closed, phone, above dialogs).
 * While it shows, the app frame starts one line lower (`globals.css`), so it covers no control
 * of the shell; nothing else marks an unsent change.
 */
import { t } from "@lingui/core/macro";
import { CloudOff } from "lucide-react";
import { useDriverSnapshot } from "@/client/commands/driver-context";

export function NotSentYet() {
  const { notSent, paused } = useDriverSnapshot();
  if (!notSent) return null;
  return (
    <div
      role="status"
      data-not-sent
      title={
        paused
          ? t`You’re signed out of this account. Sign in again and the changes will be sent.`
          : t`Changes are waiting to be sent. They go out on their own.`
      }
      style={{ top: "env(safe-area-inset-top)" }}
      className="fixed left-1/2 z-[70] flex -translate-x-1/2 items-center gap-1 h-3.5 rounded-b-sm bg-background/90 px-1.5 text-[10px] text-muted-foreground leading-none"
    >
      <CloudOff className="size-2.5" aria-hidden />
      {paused ? t`Not sent, signed out` : t`Not sent`}
    </div>
  );
}
