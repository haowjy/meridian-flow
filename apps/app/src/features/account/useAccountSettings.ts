/** Confirmed account snapshots with a tab-local optimistic command overlay. */
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getAccountSettings,
  nextAccountSettingsGeneration,
  updateAccountSettings,
} from "@/client/api/account-api";
import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import {
  ACCOUNT_SETTINGS_CACHE_PREFIX,
  readAccountSettingsCache,
  writeAccountSettingsCache,
} from "@/lib/account-settings-cache";
export type SettingKey = keyof AccountSettings;
export type SettingError = {
  kind: "rejected" | "ambiguous";
  retryValue: AccountSettings[SettingKey];
};
export type AccountPreference<K extends SettingKey> = {
  value: AccountSettings[K];
  confirmed: AccountSettings[K];
  available: boolean;
  pending: boolean;
  error: SettingError | null;
  change: (value: AccountSettings[K]) => void;
  retry: () => void;
};
type Write = {
  key: SettingKey;
  value: AccountSettings[SettingKey];
  revision: number;
  epoch: AbortSignal;
};
type Intent = { value: AccountSettings[SettingKey]; pending: boolean; error: SettingError | null };
const DEFAULTS: AccountSettings = { ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: false };
const KEYS = Object.keys(DEFAULTS) as SettingKey[];

export function useAccountSettings(
  serverValue: AccountSettings | null,
  serverReadGeneration: number,
) {
  const accountId = useAccountId();
  const epoch = useAccountEpochSignal();
  const router = useRouter();
  const [fallback] = useState(() => serverValue ?? readAccountSettingsCache(accountId) ?? DEFAULTS);
  const [confirmed, setConfirmed] = useState(serverValue);
  const confirmedRef = useRef(confirmed);
  const [intents, setIntents] = useState<Partial<Record<SettingKey, Intent>>>({});
  const intentsRef = useRef(intents);
  const revisions = useRef<Partial<Record<SettingKey, number>>>({});
  const acceptedGenerations = useRef<Partial<Record<SettingKey, number>>>({});
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  function updateIntents(next: typeof intents) {
    intentsRef.current = next;
    setIntents(next);
  }
  function acceptSnapshot(
    settings: AccountSettings,
    generation: number,
    publish: boolean,
    ownKey?: SettingKey,
  ) {
    const next = { ...(confirmedRef.current ?? settings) };
    for (const key of KEYS) {
      // Request start orders reads; settlement fences reads begun before a command completed.
      // Only pending/failed commands own the displayed value, never a settled revision.
      if (
        generation < (acceptedGenerations.current[key] ?? 0) ||
        (intentsRef.current[key] && key !== ownKey)
      )
        continue;
      Object.assign(next, { [key]: settings[key] });
      acceptedGenerations.current[key] = generation;
    }
    confirmedRef.current = next;
    setConfirmed(next);
    if (publish) writeAccountSettingsCache(accountId, next);
  }
  useEffect(() => {
    if (serverValue) acceptSnapshot(serverValue, serverReadGeneration, true);
  }, [serverValue, serverReadGeneration, accountId]);
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== ACCOUNT_SETTINGS_CACHE_PREFIX + accountId) return;
      const snapshot = readAccountSettingsCache(accountId);
      if (!snapshot) return;
      const generation = nextAccountSettingsGeneration();
      const capturedEpoch = epoch;
      acceptSnapshot(snapshot, generation, false);
      void getAccountSettings({ signal: capturedEpoch })
        .then((settings) => {
          if (!capturedEpoch.aborted && capturedEpoch === currentEpoch.current)
            acceptSnapshot(settings, generation, false);
        })
        .catch(() => undefined);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [accountId, epoch]);
  function live(write: Write) {
    return (
      !write.epoch.aborted &&
      write.epoch === currentEpoch.current &&
      revisions.current[write.key] === write.revision
    );
  }
  function success(settings: AccountSettings, write: Write) {
    if (write.epoch.aborted || write.epoch !== currentEpoch.current) return;
    acceptSnapshot(settings, nextAccountSettingsGeneration(), true, write.key);
    if (!live(write)) return;
    const next = { ...intentsRef.current };
    delete next[write.key];
    updateIntents(next);
    void router.invalidate().catch(() => undefined);
  }
  const mutation = useMutation({
    mutationKey: ["account", accountId, "settings"],
    scope: { id: `account:${accountId}:settings` },
    mutationFn: (write: Write) =>
      updateAccountSettings({ [write.key]: write.value }, { signal: write.epoch }),
    onSuccess: success,
    onError: (cause, write) => {
      if (!live(write)) return;
      const status =
        cause instanceof HttpResponseError
          ? cause.status
          : isMeridianApiError(cause)
            ? cause.status
            : undefined;
      const kind = status !== undefined && status >= 400 && status < 500 ? "rejected" : "ambiguous";
      updateIntents({
        ...intentsRef.current,
        [write.key]: {
          value: write.value,
          pending: false,
          error: { kind, retryValue: write.value },
        },
      });
      if (kind === "ambiguous") {
        const generation = nextAccountSettingsGeneration();
        void getAccountSettings({ signal: write.epoch })
          .then((settings) => {
            if (!live(write)) return;
            if (settings[write.key] === write.value) success(settings, write);
            else acceptSnapshot(settings, generation, true);
          })
          .catch(() => undefined);
      }
    },
  });
  const value = useMemo(() => {
    const next = { ...(confirmed ?? fallback) };
    for (const key of KEYS) if (intents[key]) Object.assign(next, { [key]: intents[key].value });
    return next;
  }, [confirmed, fallback, intents]);
  function preference<K extends SettingKey>(key: K): AccountPreference<K> {
    function change(next: AccountSettings[K]) {
      const revision = (revisions.current[key] ?? 0) + 1;
      revisions.current[key] = revision;
      updateIntents({ ...intentsRef.current, [key]: { value: next, pending: true, error: null } });
      mutation.mutate({ key, value: next, revision, epoch });
    }
    return {
      value: value[key],
      confirmed: (confirmed ?? DEFAULTS)[key],
      available: confirmed !== null,
      pending: intents[key]?.pending ?? false,
      error: intents[key]?.error ?? null,
      change,
      retry: () => {
        const error = intentsRef.current[key]?.error;
        if (error) change(error.retryValue as AccountSettings[K]);
      },
    };
  }
  return { value, preference, hasLocalLanguageIntent: Boolean(revisions.current.language) };
}
