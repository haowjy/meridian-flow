/** Short-lived writer feedback over permanently retained namespace receipt evidence. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import type { NamespaceIntent } from "./resource-records";

export const NAMESPACE_RECEIPT_NOTE_TTL_MS = 4_000;

type ReceiptOf<Kind extends ContextOperationReceipt["command"]["kind"]> = Extract<
  ContextOperationReceipt,
  { command: { kind: Kind } }
>;

export function namespaceReceiptIs<Kind extends ContextOperationReceipt["command"]["kind"]>(
  receipt: ContextOperationReceipt,
  kind: Kind,
): receipt is ReceiptOf<Kind> {
  return receipt.command.kind === kind;
}

/** Read the full receipt, including future result fields, without changing durable history. */
export function settledNamespaceReceipt(
  intents: readonly NamespaceIntent[],
  operationId: string,
  now = Date.now(),
  ttlMs = NAMESPACE_RECEIPT_NOTE_TTL_MS,
): ContextOperationReceipt | null {
  for (const intent of intents) {
    if (
      (intent.state !== "settled" && intent.state !== "needs-repair") ||
      intent.settledAt == null ||
      now < intent.settledAt ||
      now >= intent.settledAt + ttlMs
    )
      continue;
    for (const attempt of intent.attempts) {
      const outcome = attempt.outcome;
      if (outcome?.kind === "operation" && outcome.receipt.operationId === operationId)
        return outcome.receipt;
    }
  }
  return null;
}
