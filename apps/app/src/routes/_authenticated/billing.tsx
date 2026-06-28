/**
 * /billing — standalone subscription + extra-usage page. Authenticated users
 * land here from the Usage settings section ("Manage billing"), the usage
 * meter, or recovery flows when usage is exhausted. Renders inside the shared
 * authenticated provider shell.
 */
import { createFileRoute } from "@tanstack/react-router";

import { BillingPage } from "@/features/billing/BillingPage";

export const Route = createFileRoute("/_authenticated/billing")({
  component: BillingPage,
});
