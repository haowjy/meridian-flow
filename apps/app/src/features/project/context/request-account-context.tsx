import { createContext, useContext } from "react";
import type { RequestAccount } from "@/client/api/http-client";

export const RequestAccountContext = createContext<RequestAccount | null>(null);

export function useRequestAccount(): RequestAccount {
  const account = useContext(RequestAccountContext);
  if (!account) throw new Error("AccountFeatureComposition is required");
  return account;
}

export function useAccountId(): string {
  return useRequestAccount().id;
}
