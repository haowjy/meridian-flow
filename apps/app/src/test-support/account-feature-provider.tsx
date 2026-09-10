/** Test composition for feature suites that need one complete account lifetime. */
import { AccountFeatureComposition } from "@/features/project/context/account-feature-context";

export * from "@/features/project/context/account-feature-context";

export function AccountFeatureTestProvider({
  accountId,
  repairProjectCatalog = async () => undefined,
  children,
}: {
  accountId: string;
  repairProjectCatalog?: (projectId: string) => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <AccountFeatureComposition accountId={accountId} repairProjectCatalog={repairProjectCatalog}>
      {children}
    </AccountFeatureComposition>
  );
}
