/** Locked browser ledger for v3 local Untitled lineage envelopes. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { LocalUntitledCrossContextLeasePort } from "@/core/editor/document-session-cross-context-coordination";
import {
  type LocalUntitledLineage,
  type LocalUntitledLineageRef,
  type LocalUntitledTransition,
  type LocalUntitledTransitionResult,
  reduceLocalUntitledLineage,
} from "./local-untitled-lineage";

const LINEAGE_PREFIX = "meridian:local-untitled-lineage:v3:";

export interface LocalUntitledLineageAccess {
  snapshot(): LocalUntitledLineage | null;
  apply(command: LocalUntitledTransition): LocalUntitledTransitionResult;
  release(): Promise<void>;
}

export interface LocalUntitledLineageLedger {
  acquire(
    ref: LocalUntitledLineageRef,
  ): Promise<
    { kind: "owned-elsewhere" } | { kind: "acquired"; access: LocalUntitledLineageAccess }
  >;
  list(accountId: AccountId): readonly LocalUntitledLineage[];
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function encodeLocalUntitledLineageRef(ref: LocalUntitledLineageRef): string {
  return [ref.accountId, ref.projectId, ref.lineageHandle].map(encoded).join(":");
}

function storageKey(ref: LocalUntitledLineageRef): string {
  return `${LINEAGE_PREFIX}${encodeLocalUntitledLineageRef(ref)}`;
}

function sameRef(a: LocalUntitledLineageRef, b: LocalUntitledLineageRef): boolean {
  return (
    a.accountId === b.accountId &&
    a.projectId === b.projectId &&
    a.lineageHandle === b.lineageHandle
  );
}

function validLineage(value: unknown): value is LocalUntitledLineage {
  if (!value || typeof value !== "object") return false;
  const lineage = value as Partial<LocalUntitledLineage>;
  const ref = lineage.ref as Partial<LocalUntitledLineageRef> | undefined;
  if (
    lineage.version !== 3 ||
    !Number.isSafeInteger(lineage.envelopeRevision) ||
    typeof ref?.accountId !== "string" ||
    typeof ref.projectId !== "string" ||
    typeof ref.lineageHandle !== "string"
  )
    return false;
  if (lineage.kind === "terminal") {
    return (
      typeof lineage.documentId === "string" &&
      typeof lineage.terminalGeneration === "string" &&
      typeof lineage.transitionId === "string" &&
      typeof lineage.exactDatabaseName === "string" &&
      typeof lineage.cleanupObligationId === "string"
    );
  }
  if (lineage.kind !== "local" && lineage.kind !== "adopted") return false;
  return (
    typeof lineage.active?.documentId === "string" &&
    Number.isSafeInteger(lineage.active.identityRevision) &&
    !!lineage.work &&
    Number.isSafeInteger(lineage.work.workRevision) &&
    !!lineage.aliases &&
    typeof lineage.aliases === "object" &&
    (lineage.kind !== "local" ||
      (typeof lineage.persistence?.persistenceId === "string" &&
        typeof lineage.persistence.exactDatabaseName === "string"))
  );
}

function parse(
  raw: string | null,
  expected?: LocalUntitledLineageRef,
): LocalUntitledLineage | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return validLineage(value) && (!expected || sameRef(value.ref, expected)) ? value : null;
  } catch {
    return null;
  }
}

/** Every mutation is a reducer application while the stable lineage lock is held. */
export class BrowserLocalUntitledLineageLedger implements LocalUntitledLineageLedger {
  constructor(
    private readonly storage: Storage,
    private readonly lifetime: LocalUntitledCrossContextLeasePort,
  ) {}

  async acquire(
    ref: LocalUntitledLineageRef,
  ): Promise<
    { kind: "owned-elsewhere" } | { kind: "acquired"; access: LocalUntitledLineageAccess }
  > {
    const lease = await this.lifetime.tryAcquire(ref.projectId, ref.lineageHandle);
    if (!lease) return { kind: "owned-elsewhere" };
    let live = true;
    const access: LocalUntitledLineageAccess = {
      snapshot: () => {
        if (!live) throw new Error("Local Untitled lineage access was released");
        return parse(this.storage.getItem(storageKey(ref)), ref);
      },
      apply: (command) => {
        if (!live) throw new Error("Local Untitled lineage access was released");
        const result = reduceLocalUntitledLineage(
          parse(this.storage.getItem(storageKey(ref)), ref),
          command,
        );
        if (result.kind === "applied")
          this.storage.setItem(storageKey(ref), JSON.stringify(result.next));
        else if (result.kind === "removed") this.storage.removeItem(storageKey(ref));
        return result;
      },
      release: async () => {
        if (!live) return;
        live = false;
        await lease.release();
      },
    };
    return { kind: "acquired", access };
  }

  list(accountId: AccountId): readonly LocalUntitledLineage[] {
    const prefix = `${LINEAGE_PREFIX}${encoded(accountId)}:`;
    const lineages: LocalUntitledLineage[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const lineage = parse(this.storage.getItem(key));
      if (lineage?.ref.accountId === accountId) lineages.push(lineage);
    }
    return lineages;
  }
}
