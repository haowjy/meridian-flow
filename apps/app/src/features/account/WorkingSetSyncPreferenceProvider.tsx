/**
 * Account-lifetime owner for the cross-device working-set preference.
 *
 * The command lifecycle in `useWorkingSetSyncPreference` runs once per account,
 * not once per settings-row mount, because the working-set driver has to follow
 * the same revision-and-epoch-confirmed value the settings switch shows. Both
 * the driver and the row consume this context, so a stale or `null` loader echo
 * cannot move the driver or hide the switch once a local confirm exists.
 */
import { createContext, useContext, useState } from "react";

import { configureWorkingSetSync } from "@/client/working-set";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import {
  useWorkingSetSyncPreference,
  type WorkingSetSyncPreference,
} from "./useWorkingSetSyncPreference";

const WorkingSetSyncPreferenceContext = createContext<WorkingSetSyncPreference | null>(null);

export function WorkingSetSyncPreferenceProvider({
  serverValue,
  children,
}: {
  serverValue: boolean | null;
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
    <WorkingSetSyncPreferenceOwner key={generation} accountId={accountId} serverValue={serverValue}>
      {children}
    </WorkingSetSyncPreferenceOwner>
  );
}

function WorkingSetSyncPreferenceOwner({
  accountId,
  serverValue,
  children,
}: {
  accountId: string;
  serverValue: boolean | null;
  children: React.ReactNode;
}) {
  const preference = useWorkingSetSyncPreference(serverValue);
  // Configure during render, ahead of descendant hydration: `ReadableProjectRoute`
  // seeds the working set in a render-time `useState` initializer and the driver
  // must already know its enabled state. `configure` is idempotent for an
  // unchanged account/value pair.
  configureWorkingSetSync(accountId, preference.confirmed);
  return (
    <WorkingSetSyncPreferenceContext.Provider value={preference}>
      {children}
    </WorkingSetSyncPreferenceContext.Provider>
  );
}

export function useSharedWorkingSetSyncPreference(): WorkingSetSyncPreference {
  const preference = useContext(WorkingSetSyncPreferenceContext);
  if (!preference) {
    throw new Error("WorkingSetSyncPreferenceProvider is required");
  }
  return preference;
}
