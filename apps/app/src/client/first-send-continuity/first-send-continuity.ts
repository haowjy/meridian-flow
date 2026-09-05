/** Account-scoped durable continuity for the one Project Home first submission. */
import type { ComposerDraftSnapshot, ComposerSubmitEnvelope } from "@/components/app/composer";

export type FirstSendContinuityKey = Readonly<{
  projectId: string;
  threadId: string;
  submissionId: string;
}>;
export type FirstSendContinuityRecord = FirstSendContinuityKey &
  Readonly<{
    envelope: ComposerSubmitEnvelope;
    latestDraft: ComposerDraftSnapshot | null;
    optimisticUserTurnId: string;
    state: "ready" | "dispatching" | "ambiguous";
  }>;
export type FirstSendContinuityClaim = Readonly<{
  record: FirstSendContinuityRecord;
  dispatch: boolean;
}>;

const STORE = "continuity";

function id(key: FirstSendContinuityKey): string {
  return `${key.projectId}\u0000${key.threadId}\u0000${key.submissionId}`;
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
function complete(value: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    value.oncomplete = () => resolve();
    value.onerror = () => reject(value.error);
    value.onabort = () => reject(value.error ?? new Error("IndexedDB transaction aborted"));
  });
}
function validJsonNode(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.type === "string" &&
    (node.text === undefined || typeof node.text === "string") &&
    (node.attrs === undefined ||
      (!!node.attrs && typeof node.attrs === "object" && !Array.isArray(node.attrs))) &&
    (node.content === undefined ||
      (Array.isArray(node.content) && node.content.every(validJsonNode)))
  );
}
function validSnapshot(value: unknown): value is ComposerDraftSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const selection = snapshot.selection as Record<string, unknown> | undefined;
  return (
    Number.isSafeInteger(snapshot.revision) &&
    Number(snapshot.revision) >= 0 &&
    validJsonNode(snapshot.doc) &&
    !!selection &&
    Number.isSafeInteger(selection.anchor) &&
    Number.isSafeInteger(selection.head) &&
    Array.isArray(snapshot.ownedUploads) &&
    snapshot.ownedUploads.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const upload = item as Record<string, unknown>;
      return [upload.intakeId, upload.documentId, upload.uri, upload.locationRevision].every(
        (field) => typeof field === "string" && field.length > 0,
      );
    })
  );
}
function valid(value: unknown): value is FirstSendContinuityRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.projectId !== "string" ||
    typeof row.threadId !== "string" ||
    typeof row.submissionId !== "string" ||
    typeof row.optimisticUserTurnId !== "string" ||
    !["ready", "dispatching", "ambiguous"].includes(String(row.state)) ||
    !row.envelope ||
    typeof row.envelope !== "object"
  )
    return false;
  const envelope = row.envelope as Record<string, unknown>;
  return (
    envelope.submissionId === row.submissionId &&
    typeof envelope.acceptedRevision === "number" &&
    typeof envelope.text === "string" &&
    Array.isArray(envelope.blocks) &&
    Array.isArray(envelope.references) &&
    validSnapshot(envelope.draft) &&
    (row.latestDraft === null || validSnapshot(row.latestDraft))
  );
}

export class FirstSendContinuity {
  private database: Promise<IDBDatabase> | null = null;

  constructor(readonly accountId: string) {}

  async stage(record: FirstSendContinuityRecord): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const key = id(record);
    const existing = await request(store.get(key));
    if (existing === undefined) store.put(record, key);
    else if (
      valid(existing) &&
      record.latestDraft &&
      (!existing.latestDraft || record.latestDraft.revision > existing.latestDraft.revision)
    )
      store.put({ ...existing, latestDraft: record.latestDraft }, key);
    await complete(tx);
  }

  async updateLatest(key: FirstSendContinuityKey, snapshot: ComposerDraftSnapshot): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const current = await request(store.get(id(key)));
    if (
      valid(current) &&
      (!current.latestDraft || snapshot.revision > current.latestDraft.revision)
    )
      store.put({ ...current, latestDraft: snapshot }, id(key));
    await complete(tx);
  }

  async claim(key: FirstSendContinuityKey): Promise<FirstSendContinuityClaim | null> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const current = await request(store.get(id(key)));
    if (!valid(current)) {
      if (current !== undefined) store.delete(id(key));
      await complete(tx);
      return null;
    }
    const dispatch = current.state === "ready";
    const record = dispatch ? { ...current, state: "dispatching" as const } : current;
    if (dispatch) store.put(record, id(key));
    await complete(tx);
    return { record, dispatch };
  }

  async findForThread(
    projectId: string,
    threadId: string,
  ): Promise<FirstSendContinuityClaim | null> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readonly");
    const cursor = tx.objectStore(STORE).openCursor();
    const found = await new Promise<FirstSendContinuityRecord | null>((resolve, reject) => {
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (!value) return resolve(null);
        if (
          valid(value.value) &&
          value.value.projectId === projectId &&
          value.value.threadId === threadId
        )
          return resolve(value.value);
        value.continue();
      };
    });
    await complete(tx);
    return found ? this.claim(found) : null;
  }

  async markAmbiguous(key: FirstSendContinuityKey): Promise<void> {
    await this.updateState(key, "ambiguous");
  }

  async remove(key: FirstSendContinuityKey): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id(key));
    await complete(tx);
  }

  private async updateState(key: FirstSendContinuityKey, state: "ambiguous"): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const current = await request(store.get(id(key)));
    if (valid(current)) store.put({ ...current, state }, id(key));
    await complete(tx);
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const open = indexedDB.open(`meridian-first-send-${encodeURIComponent(this.accountId)}`, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.database;
  }
}
