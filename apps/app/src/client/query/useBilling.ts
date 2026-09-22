import type {
  BillingBalanceResponse,
  BillingTransactionsResponse,
} from "@meridian/contracts/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createCheckoutSession,
  getBillingBalance,
  getBillingProducts,
  getBillingTransactions,
} from "@/client/api/billing-api";
import {
  checkoutBaselineFrom,
  checkoutStorage,
  clearCheckoutBaseline,
  writeCheckoutBaseline,
} from "@/features/billing/checkout";

export const billingQueryKeys = {
  balance: ["billing", "balance"] as const,
  transactions: ["billing", "transactions"] as const,
  products: ["billing", "products"] as const,
};

export function useBillingBalance() {
  return useQuery({
    queryKey: billingQueryKeys.balance,
    queryFn: getBillingBalance,
    staleTime: 30_000,
  });
}

export function useBillingTransactions() {
  return useQuery({
    queryKey: billingQueryKeys.transactions,
    queryFn: getBillingTransactions,
    staleTime: 30_000,
  });
}

export function useBillingProducts() {
  return useQuery({
    queryKey: billingQueryKeys.products,
    queryFn: getBillingProducts,
    staleTime: 60_000,
  });
}

export function useCreateCheckoutSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCheckoutSession,
    onSuccess: async (session, request) => {
      // Record the pre-purchase ledger so a same-tab return can prove the delta.
      // A missing snapshot leaves the baseline absent, which keeps the return
      // honest (reconciling -> timeout) instead of confirming from the redirect.
      if (session.kind === "checkout") {
        const balance = queryClient.getQueryData<BillingBalanceResponse>(billingQueryKeys.balance);
        const transactions = queryClient.getQueryData<BillingTransactionsResponse>(
          billingQueryKeys.transactions,
        );
        if (balance && transactions) {
          writeCheckoutBaseline(
            checkoutStorage(),
            checkoutBaselineFrom(balance, transactions, request),
          );
        } else {
          clearCheckoutBaseline(checkoutStorage());
        }
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.balance }),
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.transactions }),
      ]);
      // Both kinds carry a `url`; portal sends the user to Stripe's customer
      // portal, checkout to a session page. Either way we hand off the page.
      window.location.assign(session.url);
    },
  });
}
