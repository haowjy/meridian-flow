import { AccountLifetimeProvider } from "@/client/account/account-composition";

export function AccountLifetimeTestProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  return (
    <AccountLifetimeProvider accountId={accountId} externalId={`external-${accountId}`}>
      {children}
    </AccountLifetimeProvider>
  );
}
