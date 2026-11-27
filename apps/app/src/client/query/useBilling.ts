import type {
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
} from "@meridian/contracts/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import {
  createCheckoutSession,
  getBillingBalance,
  getBillingProducts,
  getBillingTransactions,
} from "@/client/api/billing-api";

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

export interface CheckoutHandoff {
  session: CreateCheckoutSessionResponse;
  request: CreateCheckoutSessionRequest;
}

export interface UseCreateCheckoutSessionOptions {
  onHandoff?: (handoff: CheckoutHandoff, isCurrent: () => boolean) => void | Promise<void>;
}

export function useCreateCheckoutSession(options: UseCreateCheckoutSessionOptions = {}) {
  const generationRef = useRef(0);

  return useMutation({
    mutationFn: createCheckoutSession,
    onMutate: () => {
      generationRef.current += 1;
      return { generation: generationRef.current };
    },
    onSuccess: async (session, request, context) => {
      if (!context || context.generation !== generationRef.current) return;
      const isCurrent = () => context.generation === generationRef.current;
      await options.onHandoff?.({ session, request }, isCurrent);
      if (!isCurrent()) return;
      window.location.assign(session.url);
    },
  });
}
