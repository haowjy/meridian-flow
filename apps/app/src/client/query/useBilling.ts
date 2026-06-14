import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createCheckoutSession,
  getBillingBalance,
  getBillingPacks,
  getBillingTransactions,
} from "@/client/api/billing-api";

export const billingQueryKeys = {
  balance: ["billing", "balance"] as const,
  transactions: ["billing", "transactions"] as const,
  packs: ["billing", "packs"] as const,
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

export function useBillingPacks() {
  return useQuery({
    queryKey: billingQueryKeys.packs,
    queryFn: getBillingPacks,
    staleTime: 60_000,
  });
}

export function useCreateCheckoutSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCheckoutSession,
    onSuccess: async (session) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.balance }),
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.transactions }),
      ]);
      if (session.url) window.location.assign(session.url);
    },
  });
}
