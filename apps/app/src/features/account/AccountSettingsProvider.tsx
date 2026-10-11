/** One account-lifetime owner for settings and the confirmed working-set driver. */
import type { AccountSettings } from "@meridian/contracts/protocol";
import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import { useConnectivityHints } from "@/client/providers/ConnectivityProvider";
import { bindWorkingSetSyncLifetime, configureWorkingSetSync } from "@/client/working-set";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { changeLocale, resolveQueryLocale } from "@/lib/i18n";
import { changeStatsForNerds } from "@/lib/stats-for-nerds";
import { changeUiTheme } from "@/lib/ui-theme";
import { useAccountSettings } from "./useAccountSettings";

const AccountSettingsContext = createContext<ReturnType<typeof useAccountSettings> | null>(null);

export function AccountSettingsProvider({
  serverValue,
  serverReadGeneration,
  children,
}: {
  serverValue: AccountSettings | null;
  serverReadGeneration: number;
  children: React.ReactNode;
}) {
  const accountId = useAccountId();
  const accountEpoch = useAccountEpochSignal();
  // Remount the owner when the account epoch changes so a previous account's
  // confirmed override can neither seed nor drive the next account. In
  // production `AccountFeatureComposition` already unmounts this subtree on a
  // transition; the generation keeps that guarantee explicit and testable.
  const [epoch, setEpoch] = useState(accountEpoch);
  const [generation, setGeneration] = useState(0);
  if (epoch !== accountEpoch) {
    setEpoch(accountEpoch);
    setGeneration(generation + 1);
  }
  return (
    <AccountSettingsOwner
      key={generation}
      accountId={accountId}
      serverValue={serverValue}
      serverReadGeneration={serverReadGeneration}
    >
      {children}
    </AccountSettingsOwner>
  );
}

function AccountSettingsOwner({
  accountId,
  serverValue,
  serverReadGeneration,
  children,
}: {
  accountId: string;
  serverValue: AccountSettings | null;
  serverReadGeneration: number;
  children: React.ReactNode;
}) {
  const settings = useAccountSettings(serverValue, serverReadGeneration);
  const preference = settings.preference("workingSetSyncEnabled");
  useLayoutEffect(() => {
    changeUiTheme(settings.value.theme);
    // A link can choose the initial language, but never veto the writer’s choice.
    changeLocale(
      (settings.hasLocalLanguageIntent ? null : resolveQueryLocale()) ?? settings.value.language,
    );
    changeStatsForNerds(settings.value.statsForNerds);
  }, [settings.value]);
  const connectivityHints = useConnectivityHints();
  const accountEpoch = useAccountEpochSignal();
  useEffect(
    () => bindWorkingSetSyncLifetime(accountEpoch, connectivityHints),
    [accountEpoch, connectivityHints],
  );
  // Configure during render, ahead of the descendant project-route bootstrap's
  // hydration layout commit. The driver must already know its enabled state;
  // `configure` is idempotent for an unchanged account/value pair.
  configureWorkingSetSync(accountId, preference.confirmed && !accountEpoch.aborted);
  return (
    <AccountSettingsContext.Provider value={settings}>{children}</AccountSettingsContext.Provider>
  );
}

export function useSharedAccountSettings(): ReturnType<typeof useAccountSettings> {
  const preference = useContext(AccountSettingsContext);
  if (!preference) {
    throw new Error("AccountSettingsProvider is required");
  }
  return preference;
}
