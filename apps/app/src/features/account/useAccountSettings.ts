/** Account-lifetime optimistic commands, serialized and fenced per setting and account epoch. */
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { getAccountSettings, updateAccountSettings } from "@/client/api/account-api";
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
const DEFAULTS: AccountSettings = { ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: false };
export function useAccountSettings(serverValue: AccountSettings | null) {
  const accountId = useAccountId();
  const epoch = useAccountEpochSignal();
  const router = useRouter();
  const [value, setValue] = useState(
    () => readAccountSettingsCache(accountId) ?? serverValue ?? DEFAULTS,
  );
  const [confirmed, setConfirmed] = useState(serverValue);
  const hasConfirmedSnapshot = useRef(serverValue !== null);
  const [errors, setErrors] = useState<Partial<Record<SettingKey, SettingError>>>({});
  const [pending, setPending] = useState<Partial<Record<SettingKey, boolean>>>({});
  const revisions = useRef<Partial<Record<SettingKey, number>>>({});
  const storageRevision = useRef(0);
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  const values = useRef(value);
  values.current = value;
  function adopt(next: AccountSettings) {
    values.current = next;
    setValue(next);
    writeAccountSettingsCache(accountId, next);
  }
  useEffect(() => {
    if (!serverValue) return;
    hasConfirmedSnapshot.current = true;
    setConfirmed((previous) => {
      const next = { ...(previous ?? DEFAULTS) };
      for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
        if (!revisions.current[key]) Object.assign(next, { [key]: serverValue[key] });
      }
      return next;
    });
    const next = { ...values.current };
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
      if (!revisions.current[key]) Object.assign(next, { [key]: serverValue[key] });
    }
    adopt(next);
  }, [serverValue, accountId]);
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== ACCOUNT_SETTINGS_CACHE_PREFIX + accountId) return;
      const next = readAccountSettingsCache(accountId);
      if (!next) return;
      // A local pending or failed intent stays visible; other fields follow this account's tab.
      const merged = { ...values.current };
      for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
        if (!pending[key] && !errors[key]) Object.assign(merged, { [key]: next[key] });
      }
      values.current = merged;
      setValue(merged);
      const capturedStorageRevision = ++storageRevision.current;
      const capturedEpoch = epoch;
      const capturedRevisions = { ...revisions.current };
      void getAccountSettings({ signal: capturedEpoch })
        .then((settings) => {
          if (
            capturedEpoch.aborted ||
            capturedEpoch !== currentEpoch.current ||
            capturedStorageRevision !== storageRevision.current
          )
            return;
          hasConfirmedSnapshot.current = true;
          setConfirmed((previous) => {
            const next = { ...(previous ?? settings) };
            for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
              if (
                !pending[key] &&
                !errors[key] &&
                capturedRevisions[key] === revisions.current[key]
              )
                Object.assign(next, { [key]: settings[key] });
            }
            return next;
          });
        })
        .catch(() => undefined);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [accountId, pending, errors]);
  function live(write: Write) {
    return (
      !write.epoch.aborted &&
      write.epoch === currentEpoch.current &&
      revisions.current[write.key] === write.revision
    );
  }
  function success(settings: AccountSettings, write: Write) {
    if (write.epoch.aborted || write.epoch !== currentEpoch.current) return;
    const firstSnapshot = !hasConfirmedSnapshot.current;
    hasConfirmedSnapshot.current = true;
    setConfirmed((previous) => {
      const next = { ...(previous ?? settings) };
      for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
        if (key === write.key || (firstSnapshot && !revisions.current[key]))
          Object.assign(next, { [key]: settings[key] });
      }
      return next;
    });
    const next = { ...values.current };
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
      if ((firstSnapshot && !revisions.current[key]) || (key === write.key && live(write)))
        Object.assign(next, { [key]: settings[key] });
    }
    // Even a superseded write can supply the first full account snapshot.
    // Only its own field waits for the latest intent's settlement.
    adopt(next);
    if (!live(write)) return;
    setErrors((previous) => ({ ...previous, [write.key]: undefined }));
    setPending((previous) => ({ ...previous, [write.key]: false }));
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
      setPending((previous) => ({ ...previous, [write.key]: false }));
      setErrors((previous) => ({ ...previous, [write.key]: { kind, retryValue: write.value } }));
      // Never roll back the writer's choice. A read can prove an ambiguous write committed.
      if (kind === "ambiguous")
        void getAccountSettings({ signal: write.epoch })
          .then((settings) => {
            if (live(write) && settings[write.key] === write.value) success(settings, write);
          })
          .catch(() => undefined);
    },
  });
  function preference<K extends SettingKey>(key: K): AccountPreference<K> {
    function change(next: AccountSettings[K]) {
      const revision = (revisions.current[key] ?? 0) + 1;
      revisions.current[key] = revision;
      adopt({ ...values.current, [key]: next });
      setErrors((previous) => ({ ...previous, [key]: undefined }));
      setPending((previous) => ({ ...previous, [key]: true }));
      mutation.mutate({ key, value: next, revision, epoch });
    }
    return {
      value: value[key],
      confirmed: (confirmed ?? DEFAULTS)[key],
      available: confirmed !== null,
      pending: pending[key] ?? false,
      error: errors[key] ?? null,
      change,
      retry: () => {
        const error = errors[key];
        if (error) change(error.retryValue as AccountSettings[K]);
      },
    };
  }
  return { value, preference, hasLocalLanguageIntent: Boolean(revisions.current.language) };
}
