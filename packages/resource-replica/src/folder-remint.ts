/**
 * A folder id the server holds out of reach (`spent`) is replaced, as a document's is
 * (`remintResource`): the record keeps its handle and journal, takes a new `folderId`, and the old
 * id becomes an alias. Placements that named the old folder as their destination follow the new
 * id (`planFolderRemintDependents`), so work queued inside a folder lands wherever the folder does.
 */
import { remintJournal } from "./namespace-journal-policy";
import { awaitsRemint } from "./resource-intent-policy";
import type {
  FolderNamespaceRecord,
  FolderNamespaceWrite,
  NamespaceIntent,
  ResourceDestination,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";

export function remintFolder(input: {
  record: FolderNamespaceRecord;
  folderId: string;
  retryIntentId: string;
  rebasedIntentIds: Readonly<Record<string, string>>;
}): FolderNamespaceWrite | null {
  const { record } = input;
  if (!awaitsRemint(record)) return null;
  if (record.folderId === input.folderId) throw new Error("Remint requires a new folder identity");
  // A folder's intents all carry identity revision 1: nothing distinguishes them by revision.
  const intents = remintJournal({
    intents: record.intents,
    from: 1,
    to: 1,
    retryIntentId: input.retryIntentId,
    rebasedIntentIds: input.rebasedIntentIds,
  });
  if (!intents) return null;
  return {
    expectedRevision: record.revision,
    next: {
      ...record,
      revision: record.revision + 1,
      serverHold: "local",
      folderId: input.folderId,
      aliases: { ...record.aliases, [record.folderId]: true },
      intents,
    },
  };
}

function namesFolder(destination: ResourceDestination, folderId: string): boolean {
  return (
    (destination.parent.kind === "folder" && destination.parent.folderId === folderId) ||
    (destination.position !== undefined &&
      "siblingId" in destination.position &&
      destination.position.siblingId === folderId)
  );
}

function followedDestination(
  destination: ResourceDestination,
  from: string,
  to: string,
): ResourceDestination {
  const { position } = destination;
  return {
    ...destination,
    parent:
      destination.parent.kind === "folder" && destination.parent.folderId === from
        ? { kind: "folder", folderId: to }
        : destination.parent,
    ...(position && "siblingId" in position && position.siblingId === from
      ? { position: { ...position, siblingId: to } }
      : {}),
  };
}

/** The same placement queued again under the new folder id; its admission keeps its place in order. */
function followedIntent(intent: NamespaceIntent, from: string, to: string, sequence: number) {
  const { desired } = intent;
  if (desired.kind === "delete") return intent;
  const rename = (key: string) =>
    key === `entry:${from}` || key === `parent:folder:${from}` ? key.replace(from, to) : key;
  return {
    ...intent,
    intentId: `${intent.intentId}@${to}`,
    sequence,
    desired: { ...desired, destination: followedDestination(desired.destination, from, to) },
    ...(intent.admission
      ? { admission: { ...intent.admission, scope: intent.admission.scope.map(rename).sort() } }
      : {}),
  } satisfies NamespaceIntent;
}

function followsRemint(intent: NamespaceIntent, from: string): boolean {
  return (
    intent.state === "pending" &&
    intent.attempts.length === 0 &&
    intent.desired.kind !== "delete" &&
    namesFolder(intent.desired.destination, from)
  );
}

/**
 * The other journals' work that named the folder under its old id and has not been sent: each such
 * placement is cancelled and queued again under the new id, in the same transaction as the remint
 * that retires the old one. Sent work is left alone; its answer says what became of it.
 */
export function planFolderRemintDependents(input: {
  previousFolderId: string;
  folderId: string;
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
}): { resources: ResourceWrite[]; folders: FolderNamespaceWrite[] } {
  const { previousFolderId: from, folderId: to } = input;
  const follow = (intents: readonly NamespaceIntent[]): NamespaceIntent[] | null => {
    const dependents = intents.filter((intent) => followsRemint(intent, from));
    if (dependents.length === 0) return null;
    let sequence = Math.max(...intents.map((intent) => intent.sequence));
    return [
      ...intents.map((intent) =>
        dependents.includes(intent) ? { ...intent, state: "cancelled" as const } : intent,
      ),
      ...dependents.map((intent) => followedIntent(intent, from, to, ++sequence)),
    ];
  };
  const resources = input.records.flatMap((record): ResourceWrite[] => {
    const intents = follow(record.intents);
    return intents
      ? [
          {
            expectedRevision: record.resource.revision,
            next: {
              resource: { ...record.resource, revision: record.resource.revision + 1 },
              intents,
            },
          },
        ]
      : [];
  });
  const folders = input.folders.flatMap((folder): FolderNamespaceWrite[] => {
    const intents = folder.folderId === to ? null : follow(folder.intents);
    return intents
      ? [
          {
            expectedRevision: folder.revision,
            next: { ...folder, revision: folder.revision + 1, intents },
          },
        ]
      : [];
  });
  return { resources, folders };
}
