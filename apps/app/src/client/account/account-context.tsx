import { createContext, useContext } from "react";
import type { RequestAccount } from "@/client/api/http-client";

export const RequestAccountContext = createContext<RequestAccount | null>(null);
export const AccountEpochContext = createContext<AbortSignal | null>(null);
export const SignOutContext = createContext<(() => Promise<string>) | null>(null);

export function useRequestAccount(): RequestAccount {
  const account = useContext(RequestAccountContext);
  if (!account) throw new Error("AccountFeatureComposition is required");
  return account;
}

export function useAccountId(): string {
  return useRequestAccount().id;
}

export function useAccountEpochSignal(): AbortSignal {
  const signal = useContext(AccountEpochContext);
  if (!signal) throw new Error("AccountFeatureComposition is required");
  return signal;
}

export function useOptionalAccountEpochSignal(): AbortSignal | null {
  return useContext(AccountEpochContext);
}

export function useOptionalSignOutCleanup(): (() => Promise<string>) | null {
  return useContext(SignOutContext);
}
