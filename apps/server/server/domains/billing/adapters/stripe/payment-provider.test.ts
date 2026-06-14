import { describe, expect, it } from "vitest";
import { stripeInvoiceBilledPeriodForSubscription } from "./payment-provider.js";

describe("stripeInvoiceBilledPeriodForSubscription", () => {
  it("selects the non-proration line for the renewed subscription", () => {
    const invoice = {
      lines: {
        data: [
          {
            period: { start: 1_782_864_000, end: 1_785_542_400 },
            parent: { invoice_item_details: { subscription: "sub_other" } },
          },
          {
            period: { start: 1_780_272_000, end: 1_782_864_000 },
            parent: { subscription_item_details: { subscription: "sub_target", proration: true } },
          },
          {
            period: { start: 1_782_864_000, end: 1_785_542_400 },
            parent: { subscription_item_details: { subscription: "sub_target" } },
          },
        ],
      },
    };

    expect(stripeInvoiceBilledPeriodForSubscription(invoice as never, "sub_target")).toEqual({
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });
  });
});
