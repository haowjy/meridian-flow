/** Retained local deletion is writer intent, not a server tombstone or permission to purge. */
import type { NamespaceIntent, ResourceRecord, ResourceWrite } from "./resource-records";

export function planResourceDeletion(
  record: ResourceRecord,
  projectId: string,
  intentId: string,
): ResourceWrite | null {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    record.intents.some((intent) => intent.desired.kind === "delete")
  )
    return null;
  const neverSubmitted =
    record.resource.lifecycle.kind === "local" &&
    record.resource.canonical === null &&
    record.intents.every((intent) => intent.attempts.length === 0);
  const deletion: NamespaceIntent = {
    projectId,
    handle: record.resource.handle,
    intentId,
    sequence: Math.max(0, ...record.intents.map((intent) => intent.sequence)) + 1,
    identityRevision: record.resource.identity.revision,
    desired: { kind: "delete" },
    attempts: [],
    state: neverSubmitted ? "settled-locally" : "pending",
  };
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: { ...record.resource, revision: record.resource.revision + 1 },
      intents: [
        ...record.intents.map((intent) =>
          intent.attempts.length === 0 && intent.state !== "cancelled"
            ? { ...intent, state: "cancelled" as const }
            : intent,
        ),
        deletion,
      ],
    },
  };
}
