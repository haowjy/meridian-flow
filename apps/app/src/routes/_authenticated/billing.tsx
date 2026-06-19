/**
 * /billing — standalone credit purchase page. Authenticated users land here
 * from the Usage settings section ("Add credits"), the credit-balance badge, or
 * credits-exhausted recovery flows. Renders inside the shared authenticated
 * provider shell.
 */
import { createFileRoute } from "@tanstack/react-router";

import { BillingPage } from "@/features/billing/BillingPage";

export const Route = createFileRoute("/_authenticated/billing")({
  component: BillingPage,
});
