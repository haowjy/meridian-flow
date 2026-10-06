/** Localized presentation for structured Work receipt facts. */
import type { WorkReceipt } from "@meridian/contracts/works";
import { i18n } from "@/lib/i18n";

export function workReceiptLine(receipt: WorkReceipt): string {
  switch (receipt.operation) {
    case "create": {
      const values = { name: receipt.workName };
      return i18n._("workReceipt.created", values, { message: "Created Work {name}" });
    }
    case "update": {
      const values = { name: receipt.workName };
      if (receipt.before?.archived !== receipt.after?.archived) {
        return receipt.after?.archived
          ? i18n._("workReceipt.archived", values, { message: "Archived Work {name}" })
          : i18n._("workReceipt.unarchived", values, { message: "Unarchived Work {name}" });
      }
      return receipt.changed
        ? i18n._("workReceipt.updated", values, { message: "Updated Work {name}" })
        : i18n._("workReceipt.upToDate", values, {
            message: "Work {name} was already up to date",
          });
    }
    case "delete": {
      const values = { name: receipt.workName };
      return i18n._("workReceipt.deleted", values, { message: "Deleted Work {name}" });
    }
  }
}
