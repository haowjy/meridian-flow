import { t } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getAuthMe } from "@/client/api/auth-api";
import { Button } from "@/components/ui/button";
import {
  AccountFeatureLifetime,
  SignOutIncomplete,
} from "@/features/project/context/account-feature-lifetime";

export const Route = createFileRoute("/logout")({
  ssr: false,
  preload: false,
  component: Logout,
});

function Logout() {
  const [failed, setFailed] = useState(false);
  const [signOut] = useState(() => signOutOfThisBrowser(setFailed));
  useEffect(() => void signOut(), [signOut]);

  return (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3" role={failed ? "alert" : "status"}>
        <p>{failed ? t`Couldn't log out` : t`Logging out…`}</p>
        {failed ? (
          <Button variant="outline" onClick={() => void signOut()}>
            {t`Retry`}
          </Button>
        ) : null}
      </div>
    </main>
  );
}

function signOutOfThisBrowser(setFailed: (failed: boolean) => void): () => Promise<void> {
  let lifetime: AccountFeatureLifetime | null = null;
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    setFailed(false);
    try {
      const me = await getAuthMe().catch(() => null);
      if (!me) return window.location.replace("/end-session");
      lifetime ??= new AccountFeatureLifetime(me.user.userId, me.user.externalId);
      window.location.replace(await lifetime.clearForSignOut());
    } catch (error) {
      if (!(error instanceof SignOutIncomplete)) reportError(error);
      running = false;
      setFailed(true);
    }
  };
}
