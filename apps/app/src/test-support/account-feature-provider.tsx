/** Test composition for feature suites that need one complete account lifetime. */
import { QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AccountFeatureComposition } from "@/features/project/context/account-feature-context";

export * from "@/features/project/context/account-feature-context";

export function AccountFeatureTestProvider({
  accountId,
  queryClient,
  children,
}: {
  accountId: string;
  queryClient?: QueryClient;
  children: React.ReactNode;
}) {
  const [ownClient] = useState(() => new QueryClient());
  return (
    <AccountFeatureComposition accountId={accountId} queryClient={queryClient ?? ownClient}>
      {children}
    </AccountFeatureComposition>
  );
}
