/** One account-lifetime owner for settings. */
import type { AccountSettings } from "@meridian/contracts/protocol";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import { useAccountEpochSignal } from "@/features/project/context/account-feature-context";
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
      serverValue={serverValue}
      serverReadGeneration={serverReadGeneration}
    >
      {children}
    </AccountSettingsOwner>
  );
}

function AccountSettingsOwner({
  serverValue,
  serverReadGeneration,
  children,
}: {
  serverValue: AccountSettings | null;
  serverReadGeneration: number;
  children: React.ReactNode;
}) {
  const settings = useAccountSettings(serverValue, serverReadGeneration);
  useLayoutEffect(() => {
    changeUiTheme(settings.value.theme);
    // A link can choose the initial language, but never veto the writer’s choice.
    changeLocale(
      (settings.hasLocalLanguageIntent ? null : resolveQueryLocale()) ?? settings.value.language,
    );
    changeStatsForNerds(settings.value.statsForNerds);
  }, [settings.value]);
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
