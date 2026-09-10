import type { WorkReceipt } from "@meridian/contracts/works";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, i18n } from "@/lib/i18n";
import { testWorkSlug } from "@/test-support/work-slug";
import { workReceiptLine } from "./work-receipt-copy";

describe("Work receipt presentation", () => {
  afterEach(() => i18n.activate(DEFAULT_LOCALE));

  it("maps structured facts through the active non-English catalog", () => {
    i18n.load("receipt-test", {
      "workReceipt.switched": "已将此对话切换到工作 {name}",
    });
    i18n.activate("receipt-test");
    const receipt: WorkReceipt = {
      operation: "switch",
      category: "binding",
      before: { kind: "none" },
      after: {
        kind: "work",
        workId: "w1",
        workSlug: testWorkSlug("volume-two"),
        name: "第二卷",
        goal: null,
        description: null,
        status: "active",
      },
      inverse: null,
    };
    expect(workReceiptLine(receipt)).toBe("已将此对话切换到工作 第二卷");
  });
});
