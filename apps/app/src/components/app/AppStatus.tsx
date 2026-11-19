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
  const { notSent } = useDriverSnapshot();
  if (!notSent) return null;
  return (
    <span role="status" className={WORD}>
      <CloudOff className="size-3" aria-hidden />
      {t`Not sent`}
    </span>
  );
}
