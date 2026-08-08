/** Localized presentation for structured Work receipt facts. */
import type { WorkReceipt } from "@meridian/contracts/works";
import { i18n } from "@/lib/i18n";

export function workReceiptLine(receipt: WorkReceipt): string {
  const values = { name: receipt.workName };
  switch (receipt.operation) {
    case "create":
      return i18n._("workReceipt.created", values, { message: "Created Work {name}" });
    case "update":
      if (receipt.before?.status !== receipt.after?.status) {
        return receipt.after?.status === "archived"
          ? i18n._("workReceipt.archived", values, { message: "Archived Work {name}" })
          : i18n._("workReceipt.unarchived", values, { message: "Unarchived Work {name}" });
      }
      return receipt.changed
        ? i18n._("workReceipt.updated", values, { message: "Updated Work {name}" })
        : i18n._("workReceipt.upToDate", values, {
            message: "Work {name} was already up to date",
          });
    case "delete":
      return i18n._("workReceipt.deleted", values, { message: "Deleted Work {name}" });
    case "switch":
      return receipt.changed
        ? i18n._("workReceipt.switched", values, {
            message: "Switched this conversation to Work {name}",
          })
        : i18n._("workReceipt.alreadyCurrent", values, {
            message: "This conversation is already using Work {name}",
          });
  }
}
