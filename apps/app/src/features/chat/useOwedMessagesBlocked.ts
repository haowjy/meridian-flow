/**
 * Whether the chat's owed messages can't be taken on because the account can't
 * start a turn.
 *
 * The server refuses to start any execution while `canStartTurn` is false, and
 * the message stays pending until a later send wakes the chat. Nothing else
 * says so to the chat, so while messages wait with nothing running, the
 * balance is read fresh: when it can't start a turn, the composer stays idle
 * (as it did before the follow rule) rather than working with nothing to stop.
 */
import { useQuery } from "@tanstack/react-query";
import { getBillingBalance } from "@/client/api/billing-api";
import { billingQueryKeys } from "@/client/query/useBilling";

export function useOwedMessagesBlocked(waiting: boolean): boolean {
  const balance = useQuery({
    queryKey: billingQueryKeys.balance,
    queryFn: getBillingBalance,
    enabled: waiting,
    staleTime: 0,
  });
  return waiting && balance.data?.canStartTurn === false;
}
