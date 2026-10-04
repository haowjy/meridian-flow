/** One-attempt post-commit delivery of sorted ContextFS membership events. */
import { randomUUID } from "node:crypto";
import { runOutsideDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { runOutsideEditConfirmation } from "../../../../shared/edit-confirmation.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../../observability/index.js";

export interface ContextDocumentMembershipObserver {
  documentCreated(documentId: string): void | Promise<void>;
  documentDeleted(documentId: string): void | Promise<void>;
}

export type ContextDocumentMembershipEvent = {
  method: keyof ContextDocumentMembershipObserver;
  documentId: string;
};

/**
 * Runs a membership callback after its mutation commits: outside that
 * transaction, and outside the mutation's edit grants (manifest bookkeeping
 * is a derived write; a deleted document's grant no longer confirms).
 */
export function runMembershipCallback<T>(callback: () => T): T {
  return runOutsideDrizzleTransaction(() => runOutsideEditConfirmation(callback));
}

export function createMembershipCommandId(): string {
  return randomUUID();
}

export async function dispatchMembershipEvents(input: {
  observer?: ContextDocumentMembershipObserver;
  events: readonly ContextDocumentMembershipEvent[];
  commandId: string;
  eventSink?: EventSink;
}): Promise<void> {
  if (!input.observer) return;
  const events = [...input.events].sort(
    (left, right) =>
      left.documentId.localeCompare(right.documentId) || left.method.localeCompare(right.method),
  );
  const settled = await Promise.allSettled(
    events.map((event) =>
      Promise.resolve().then(() =>
        runMembershipCallback(() => input.observer?.[event.method](event.documentId)),
      ),
    ),
  );
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") continue;
    const event = events[index];
    if (!event || !input.eventSink) continue;
    emitEvent(input.eventSink, {
      level: "error",
      source: "context-tree-mutation",
      name: "PostCommitCallbackFailure",
      payload: {
        commandId: input.commandId,
        callbackKind: event.method,
        documentId: event.documentId,
        ...unknownToEventPayload(outcome.reason),
      },
    });
  }
}
