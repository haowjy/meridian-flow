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
  const words = (
    <>
      <CloudOff className="size-3" aria-hidden />
      {t`Not sent`}
    </>
  );
  if (paused)
    return (
      <button
        type="button"
        onClick={logInAgain}
        aria-label={t`Not sent. Log in`}
        className={`${WORD} cursor-pointer hover:text-foreground`}
      >
        {words}
      </button>
    );
  return (
    <span role="status" className={WORD}>
      {words}
    </span>
  );
}

export function logInAgain() {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?redirect=${encodeURIComponent(here)}`);
}
