/**
 * useWorkingSetSyncPreference — P1 command for the cross-device working-set
 * preference.
 *
 * `PATCH /api/account/settings` is an absolute set with no version or idempotency
 * key, so a repeated write is safe and an ambiguous result can be settled by the
 * authoritative GET. The authenticated route loader stays the read owner; this
 * hook owns only the immediate projection the settings row shows and the
 * transient write lifecycle (direct TanStack `useMutation`, no wrapper/store).
 */
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { getAccountSettings, updateAccountSettings } from "@/client/api/account-api";
import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

export type WorkingSetSyncFailure = "rejected" | "ambiguous";

export type WorkingSetSyncRowError = {
  kind: WorkingSetSyncFailure;
  /** The exact intent to re-dispatch; never derived from the current value. */
  retryValue: boolean;
};

export type WorkingSetSyncPreference = {
  value: boolean;
  pending: boolean;
  error: WorkingSetSyncRowError | null;
  change: (value: boolean) => void;
  retry: () => void;
};

type WriteVariables = { value: boolean; revision: number; accountId: string };

/**
 * A typed 4xx proves the PATCH did not commit. A network error, abort, or
 * unknown 5xx leaves the committed result unknown and is ambiguous.
 */
export function classifyWorkingSetSyncFailure(error: unknown): WorkingSetSyncFailure {
  const status =
    error instanceof HttpResponseError
      ? error.status
      : isMeridianApiError(error)
        ? error.status
        : undefined;
  return status !== undefined && status >= 400 && status < 500 ? "rejected" : "ambiguous";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function useWorkingSetSyncPreference(serverValue: boolean | null): WorkingSetSyncPreference {
  const accountId = useAccountId();
  const accountEpoch = useAccountEpochSignal();
  const router = useRouter();
  const [value, setValue] = useState(serverValue ?? false);
  const [error, setError] = useState<WorkingSetSyncRowError | null>(null);
  const confirmedRef = useRef(serverValue ?? false);
  const revisionRef = useRef(0);
  const pendingRevisionRef = useRef<number | null>(null);
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;

  useEffect(() => {
    if (serverValue === null) return;
    confirmedRef.current = serverValue;
    // A newer intent is still settling; the loader prop must not clobber it.
    if (pendingRevisionRef.current !== null) return;
    setValue(serverValue);
  }, [serverValue]);

  const mutation = useMutation({
    mutationKey: ["account", accountId, "settings", "working-set-sync"],
    // Serialize per setting: absolute-set PATCHes must not interleave, or the
    // server can end on an older value than the writer last chose.
    scope: { id: `account:${accountId}:working-set-sync` },
    mutationFn: ({ value: next }: WriteVariables) =>
      updateAccountSettings({ workingSetSyncEnabled: next }, { signal: accountEpoch }),
    onSuccess: (settings, variables) => {
      if (variables.accountId !== accountIdRef.current) return;
      confirmedRef.current = settings.workingSetSyncEnabled;
      // Refresh the loader-owned read so the working-set driver tracks every
      // confirmed server value, including an older queued write's.
      void router.invalidate().catch(() => undefined);
      if (variables.revision !== revisionRef.current) return;
      setValue(settings.workingSetSyncEnabled);
      setError(null);
    },
    onError: (cause, variables) => {
      if (variables.accountId !== accountIdRef.current) return;
      // Account teardown aborts transport; that is abandoned, not a refusal.
      if (isAbortError(cause)) return;
      if (variables.revision !== revisionRef.current) return;
      const kind = classifyWorkingSetSyncFailure(cause);
      if (kind === "rejected") {
        setValue(confirmedRef.current);
        setError({ kind, retryValue: variables.value });
        return;
      }
      setError({ kind, retryValue: variables.value });
      void reconcile(variables);
    },
    onSettled: (_data, _error, variables) => {
      if (pendingRevisionRef.current === variables.revision) pendingRevisionRef.current = null;
    },
  });

  function reconcile(variables: WriteVariables) {
    void getAccountSettings({ signal: accountEpoch })
      .then((settings) => {
        if (variables.accountId !== accountIdRef.current) return;
        // A newer intent has superseded this reconciliation; its own settle owns
        // the confirmed value and the row error.
        if (variables.revision !== revisionRef.current) return;
        confirmedRef.current = settings.workingSetSyncEnabled;
        if (settings.workingSetSyncEnabled === variables.value) setError(null);
      })
      .catch(() => undefined);
  }

  function change(next: boolean) {
    const revision = ++revisionRef.current;
    pendingRevisionRef.current = revision;
    setValue(next);
    setError(null);
    mutation.mutate({ value: next, revision, accountId: accountIdRef.current });
  }

  function retry() {
    if (!error) return;
    change(error.retryValue);
  }

  return { value, pending: mutation.isPending, error, change, retry };
}
