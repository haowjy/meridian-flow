/** useWorkingSetSyncPreference — P1 command for the cross-device working-set preference. */
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

export type WorkingSetSyncFailure = "rejected" | "ambiguous";

export type WorkingSetSyncRowError = {
  kind: WorkingSetSyncFailure;
  /** The exact intent to re-dispatch; never derived from the current value. */
  retryValue: boolean;
};

export type WorkingSetSyncPreference = {
  value: boolean;
  /** The last revision-and-epoch-confirmed server value. */
  confirmed: boolean;
  /** Whether an authoritative value exists (a loader seed or a local confirm). */
  available: boolean;
  pending: boolean;
  error: WorkingSetSyncRowError | null;
  change: (value: boolean) => void;
  retry: () => void;
};

type WriteVariables = {
  value: boolean;
  revision: number;
  accountId: string;
  /** Account epoch captured at dispatch; a later epoch must not adopt this write. */
  epochSignal: AbortSignal;
};

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
  // `serverConfirmed` drives the shared override; `confirmedRef` stays the
  // synchronous base a rejection reverts to. Both advance on the same settle.
  const [serverConfirmed, setServerConfirmed] = useState<boolean | null>(serverValue);
  const [error, setError] = useState<WorkingSetSyncRowError | null>(null);
  const confirmedRef = useRef(serverValue ?? false);
  const revisionRef = useRef(0);
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;
  const epochSignalRef = useRef(accountEpoch);
  epochSignalRef.current = accountEpoch;

  useEffect(() => {
    if (serverValue === null) return;
    // Seed from the loader only before this session writes. Once a revision
    // exists the prop is not authoritative: a late `invalidate()` from an older
    // write can echo a pre-toggle value and clobber the latest intent.
    if (revisionRef.current !== 0) return;
    confirmedRef.current = serverValue;
    setServerConfirmed(serverValue);
    setValue(serverValue);
  }, [serverValue]);

  /** A settle is live only while its captured epoch is still open and current. */
  function isCurrentEpoch(variables: WriteVariables): boolean {
    return (
      !variables.epochSignal.aborted &&
      variables.epochSignal === epochSignalRef.current &&
      variables.accountId === accountIdRef.current
    );
  }

  /** Adopt a server-confirmed value. */
  function applyConfirmed(settings: AccountSettings, variables: WriteVariables) {
    if (!isCurrentEpoch(variables)) return;
    confirmedRef.current = settings.workingSetSyncEnabled;
    setServerConfirmed(settings.workingSetSyncEnabled);
    if (variables.revision !== revisionRef.current) return;
    setValue(settings.workingSetSyncEnabled);
    setError(null);
    void router.invalidate().catch(() => undefined);
  }

  const mutation = useMutation({
    mutationKey: ["account", accountId, "settings", "working-set-sync"],
    // Serialize per setting: absolute-set PATCHes must not interleave, or the
    // server can end on an older value than the writer last chose.
    scope: { id: `account:${accountId}:working-set-sync` },
    // The signal is read from the captured variables, not the render closure:
    // a queued write serialized behind an in-flight one must keep its own epoch.
    mutationFn: ({ value: next, epochSignal }: WriteVariables) =>
      updateAccountSettings({ workingSetSyncEnabled: next }, { signal: epochSignal }),
    onSuccess: (settings, variables) => {
      applyConfirmed(settings, variables);
    },
    onError: (cause, variables) => {
      // Account teardown aborts the epoch with a plain Error, so classify by the
      // signal rather than the error name: an aborted epoch is abandoned, never
      // a writer-visible refusal, and must not start a reconcile.
      if (variables.epochSignal.aborted || isAbortError(cause)) return;
      if (!isCurrentEpoch(variables)) return;
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
  });

  function reconcile(variables: WriteVariables) {
    void getAccountSettings({ signal: variables.epochSignal })
      .then((settings) => {
        if (!isCurrentEpoch(variables)) return;
        // A newer intent has superseded this reconciliation; its own settle owns
        // the confirmed value and the row error.
        if (variables.revision !== revisionRef.current) return;
        if (settings.workingSetSyncEnabled === variables.value) {
          // The GET proves the ambiguous write committed even though the PATCH
          // response was lost: propagate it like a success so the projection and
          // the working-set driver follow the server.
          applyConfirmed(settings, variables);
          return;
        }
        // Unconfirmed: keep the optimistic intent and the ambiguous copy so
        // Retry can re-dispatch. The read is still authoritative for the
        // confirmed base the driver follows.
        confirmedRef.current = settings.workingSetSyncEnabled;
        setServerConfirmed(settings.workingSetSyncEnabled);
      })
      .catch(() => undefined);
  }

  function change(next: boolean) {
    const revision = ++revisionRef.current;
    setValue(next);
    setError(null);
    mutation.mutate({
      value: next,
      revision,
      accountId: accountIdRef.current,
      epochSignal: accountEpoch,
    });
  }

  function retry() {
    if (!error) return;
    change(error.retryValue);
  }

  return {
    value,
    confirmed: serverConfirmed === true,
    available: serverConfirmed !== null,
    pending: mutation.isPending,
    error,
    change,
    retry,
  };
}
