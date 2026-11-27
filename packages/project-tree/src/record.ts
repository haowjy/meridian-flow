export type NodeKind = "folder" | "document" | "file";
export type DraftId = string;
export type Actor = string;
export type BlobRef = { storageKey: string; mime: string; size: number };

export const SYSTEM_ACTOR: Actor = "system";

export function userActor(userId: string): Actor {
  return `user:${userId}`;
}
export function agentActor(threadId: string, turnId: string): Actor {
  return `agent:${threadId}/${turnId}`;
}

export type ActorOf =
  | { kind: "user"; userId: string }
  | { kind: "agent"; threadId: string }
  | { kind: "other" };

export function readActor(actor: Actor): ActorOf {
  if (actor.startsWith("user:")) return { kind: "user", userId: actor.slice("user:".length) };
  if (actor.startsWith("agent:"))
    return { kind: "agent", threadId: actor.slice("agent:".length).split("/")[0] ?? "" };
  return { kind: "other" };
}

export function sourceRoot(sourceId: string): string {
  return `source:${sourceId}`;
}
export function isSourceRoot(id: string): boolean {
  return id.startsWith("source:");
}
export function sourceIdOf(root: string): string {
  return root.slice("source:".length);
}

export function newId(): string {
  return crypto.randomUUID();
}

type RecordBase = {
  id: string;
  node: string;
  actor: Actor;
  draft: DraftId | null;
  carries?: string;
  appliedBy?: Actor;
  fromDraft?: DraftId;
  undoes?: string;
  restores?: string;
  restoredBy?: Actor;
};

export type CreateRecord = RecordBase & {
  type: "create";
  kind: NodeKind;
  name: string;
  parent: string;
  source: string;
  rank: string;
  filetype?: string;
  provisional?: true;
  aliases?: string[];
  hasProperties?: true;
  blob?: BlobRef;
};
export type MoveRecord = RecordBase & {
  type: "move";
  parent: string;
  rank: string;
  from: { parent: string; rank: string };
};
export type RenameRecord = RecordBase & {
  type: "rename";
  name: string;
  fromName: string;
  filetype?: string;
};
export type DeleteRecord = RecordBase & { type: "delete"; cascade: string[] };
export type RestoreRecord = RecordBase & { type: "restore" };
export type PurgeRecord = RecordBase & { type: "purge"; delete: string; nodes: string[] };

export type TreeRecord =
  | CreateRecord
  | MoveRecord
  | RenameRecord
  | DeleteRecord
  | RestoreRecord
  | PurgeRecord;

type WithoutBase<T> = Omit<T, keyof RecordBase | "node"> & { node: string };
export type TreeRecordInput =
  | WithoutBase<CreateRecord>
  | WithoutBase<MoveRecord>
  | WithoutBase<RenameRecord>
  | WithoutBase<DeleteRecord>
  | WithoutBase<RestoreRecord>
  | WithoutBase<PurgeRecord>;

export type Settlement = "applied" | "discarded" | "superseded" | "dropped";

export type SettleRecord = {
  id: string;
  actor: Actor;
  targets: string[];
  to: Settlement | "pending";
  reason?: string;
  command?: string;
};
