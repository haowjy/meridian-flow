import { AccountFeatureComposition } from "@/features/project/context/account-feature-context";

export * from "@/features/project/context/account-feature-context";

export function AccountFeatureTestProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  return <AccountFeatureComposition accountId={accountId}>{children}</AccountFeatureComposition>;
}
