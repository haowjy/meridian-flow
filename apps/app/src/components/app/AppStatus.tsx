/**
 * The app-wide state words: "Not sent" while something the writer did has gone unanswered for a
 * while or the browser is offline with something waiting, and the update word once the app was
 * deployed under this tab. The shell places them in the trailing area of the band it already has
 * (main's header on desktop, the phone top bar), so they take room the band already has, change the
 * height of nothing and cover no control; both can show together.
 */
import { t } from "@lingui/core/macro";
import { CloudOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useDriverSnapshot } from "@/client/commands/driver-context";
import { releaseStore, reloadNow } from "@/client/release/release";

const WORD = "flex shrink-0 items-center gap-1 self-center px-1.5 text-xs text-muted-foreground";

export function AppStatus() {
  return (
    <>
      <UpdateWord />
      <NotSentWord />
    </>
  );
}

function UpdateWord() {
  const phase = useSyncExternalStore(
    releaseStore.subscribe,
    releaseStore.getSnapshot,
    () => "current" as const,
  );
  if (phase === "current") return null;
  const reload = t`Reload to update`;
  return (
    <button
      type="button"
      onClick={reloadNow}
      aria-label={reload}
      title={
        phase === "must-reload"
          ? t`This tab needs the new version to keep working. It reloads when you pause; unsent changes go out afterwards.`
          : t`A new version of Meridian is ready.`
      }
      className={`${WORD} cursor-pointer hover:text-foreground`}
    >
      <ReloadWords />
    </button>
  );
}

/** The update word's text, wherever a reload of the tab is the only way on. */
export function ReloadWords() {
  return (
    <>
      <span className="max-sm:hidden">{t`Reload to update`}</span>
      <span className="sm:hidden">{t`Update`}</span>
    </>
  );
}

function NotSentWord() {
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
      className={WORD}
    >
      <CloudOff className="size-3" aria-hidden />
      {paused ? t`Not sent, signed out` : t`Not sent`}
    </span>
  );
}
