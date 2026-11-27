import { AccountFeatureComposition } from "@/client/account/account-composition";

export function AccountFeatureTestProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  return (
    <AccountFeatureComposition accountId={accountId} externalId={`external-${accountId}`}>
      {children}
    </AccountFeatureComposition>
  );
}
