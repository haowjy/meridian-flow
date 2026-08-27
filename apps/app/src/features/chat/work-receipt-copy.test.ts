import type { WorkReceipt } from "@meridian/contracts/works";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, i18n } from "@/lib/i18n";
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
      changed: true,
      workId: "w1",
      workName: "第二卷",
      before: null,
      after: null,
      inverse: { command: "switch", workId: "w0" },
    };
    expect(workReceiptLine(receipt)).toBe("已将此对话切换到工作 第二卷");
  });
});
