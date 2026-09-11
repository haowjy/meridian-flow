/** Account-scoped creation draft slots and first-send admission continuity. */
import type { ComposerDraftSnapshot, ComposerSubmitEnvelope } from "@/components/app/composer";

export type FirstSendContinuityKey = Readonly<{
  projectId: string;
  threadId: string;
  submissionId: string;
}>;
export type FirstSendContinuityRecord = FirstSendContinuityKey &
  Readonly<{
    creation: { projectId: string | null; attemptId: string; draftRevision: number };
    envelope: ComposerSubmitEnvelope;
    latestDraft: ComposerDraftSnapshot | null;
    optimisticUserTurnId: string;
    state: "ready" | "dispatching" | "ambiguous";
  }>;
export type FirstSendContinuityClaim = Readonly<{
  record: FirstSendContinuityRecord;
  dispatch: boolean;
}>;

export type CreationRefusal = "work_unavailable" | "agent_not_found";

export type CreationAttempt = Readonly<{
  attemptId: string;
  projectId: string;
  threadId: string;
  title: string;
  workId: string | null;
  agentSlug: string;
  submission: ComposerSubmitEnvelope | null;
  phase: "creating" | "ambiguous" | "refused" | "mismatched" | "ready";
  refusal?: CreationRefusal;
  projectSlug?: string;
  threadSlug?: string;
}>;
export type CreationSlot = Readonly<{
  version: 1;
  revision: number;
  draftRevision: number;
  draft: ComposerDraftSnapshot | null;
  attempt: (CreationAttempt & { draftRevision: number | null }) | null;
}>;
export type CreationSlotResult = { kind: "saved" | "conflict"; slot: CreationSlot };
const EMPTY_CREATION: CreationSlot = {
  version: 1,
  revision: 0,
  draftRevision: 0,
  draft: null,
  attempt: null,
};
const CREATION_STORE = "creation";
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
  return (
    validCreationLink(row.creation) &&
    validSubmission(row.envelope) &&
    row.envelope.submissionId === row.submissionId &&
    (row.latestDraft === null || validSnapshot(row.latestDraft))
  );
}
function validCreationLink(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const link = value as Record<string, unknown>;
  return (
    (link.projectId === null || typeof link.projectId === "string") &&
    typeof link.attemptId === "string" &&
    link.attemptId.length > 0 &&
    Number.isSafeInteger(link.draftRevision) &&
    Number(link.draftRevision) >= 0
  );
}
function validSubmission(value: unknown): value is ComposerSubmitEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope.submissionId === "string" &&
    typeof envelope.acceptedRevision === "number" &&
    typeof envelope.text === "string" &&
    Array.isArray(envelope.blocks) &&
    Array.isArray(envelope.references) &&
    validSnapshot(envelope.draft)
  );
}
function validCreationAttempt(value: unknown): value is CreationSlot["attempt"] {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const attempt = value as Record<string, unknown>;
  return (
    [
      attempt.attemptId,
      attempt.projectId,
      attempt.threadId,
      attempt.title,
      attempt.agentSlug,
    ].every((field) => typeof field === "string") &&
    (attempt.draftRevision === null ||
      (Number.isSafeInteger(attempt.draftRevision) && Number(attempt.draftRevision) >= 0)) &&
    (attempt.workId === null || typeof attempt.workId === "string") &&
    (attempt.submission === null || validSubmission(attempt.submission)) &&
    ["creating", "ambiguous", "refused", "mismatched", "ready"].includes(String(attempt.phase)) &&
    (attempt.refusal === undefined ||
      attempt.refusal === "work_unavailable" ||
      attempt.refusal === "agent_not_found") &&
    (attempt.projectSlug === undefined || typeof attempt.projectSlug === "string") &&
    (attempt.threadSlug === undefined || typeof attempt.threadSlug === "string")
  );
}

export class FirstSendContinuity {
  private database: Promise<IDBDatabase> | null = null;
  private creationListeners = new Map<string | null, Set<(slot: CreationSlot) => void>>();

  subscribeCreation(projectId: string | null, listener: (slot: CreationSlot) => void): () => void {
    const listeners = this.creationListeners.get(projectId) ?? new Set();
    this.creationListeners.set(projectId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.creationListeners.delete(projectId);
    };
  }
  private notifyCreation(projectId: string | null, slot: CreationSlot) {
    for (const listener of this.creationListeners.get(projectId) ?? []) listener(slot);
  }

  constructor(readonly accountId: string) {}

  /** A null project identifies the account's single new-project composer. */
  async readCreation(projectId: string | null): Promise<CreationSlot> {
    const db = await this.open();
    const tx = db.transaction(CREATION_STORE, "readonly");
    const value = await request(tx.objectStore(CREATION_STORE).get(projectId ?? ""));
    await complete(tx);
    return this.creationSlot(value);
  }

  async saveCreationDraft(
    projectId: string | null,
    expectedRevision: number,
    draft: ComposerDraftSnapshot | null,
  ): Promise<CreationSlotResult> {
    return this.changeCreation(projectId, (slot) =>
      slot.revision === expectedRevision
        ? { ...slot, draft, draftRevision: slot.draftRevision + 1 }
        : null,
    );
  }

  async beginCreation(
    projectId: string | null,
    expectedRevision: number,
    attempt: CreationAttempt,
  ): Promise<CreationSlotResult> {
    return this.changeCreation(projectId, (slot) =>
      slot.revision === expectedRevision &&
      !slot.attempt &&
      (projectId === null || attempt.projectId === projectId)
        ? {
            ...slot,
            attempt: {
              ...attempt,
              draftRevision:
                attempt.submission &&
                JSON.stringify(slot.draft) === JSON.stringify(attempt.submission.draft)
                  ? slot.draftRevision
                  : null,
            },
          }
        : null,
    );
  }

  /** A definite refusal admits corrected creation choices, never an uncertain attempt. */
  async reviseRefusedCreation(
    projectId: string | null,
    attemptId: string,
    choices: { workId: string | null; agentSlug: string },
  ): Promise<CreationSlotResult> {
    return this.changeCreation(projectId, (slot) =>
      slot.attempt?.attemptId === attemptId && slot.attempt.phase === "refused"
        ? {
            ...slot,
            attempt: {
              ...slot.attempt,
              ...choices,
              attemptId: crypto.randomUUID(),
              threadId: crypto.randomUUID(),
              phase: "creating",
              refusal: undefined,
            },
          }
        : null,
    );
  }

  async settleCreation(
    projectId: string | null,
    attemptId: string,
    outcome: { phase: "ambiguous" | "refused" | "mismatched"; refusal?: CreationRefusal },
  ): Promise<CreationSlotResult> {
    return this.changeCreation(projectId, (slot) =>
      slot.attempt?.attemptId === attemptId
        ? { ...slot, attempt: { ...slot.attempt, ...outcome } }
        : null,
    );
  }

  async clearMismatchedCreation(
    projectId: string | null,
    attemptId: string,
  ): Promise<CreationSlotResult> {
    return this.changeCreation(projectId, (slot) =>
      slot.attempt?.attemptId === attemptId && slot.attempt.phase === "mismatched"
        ? { ...slot, attempt: null }
        : null,
    );
  }

  async finishCreation(projectId: string | null, attemptId: string): Promise<CreationSlotResult> {
    return this.changeCreation(projectId, (slot) =>
      slot.attempt?.attemptId === attemptId &&
      slot.attempt.phase === "ready" &&
      !slot.attempt.submission
        ? {
            ...slot,
            draft: slot.draft,
            attempt: null,
          }
        : null,
    );
  }

  /** Commit the navigation destination and first-send admission as one durable fact. */
  async publishCreation(
    projectId: string | null,
    attemptId: string,
    destination: { projectSlug: string; threadSlug: string; optimisticUserTurnId?: string },
  ): Promise<CreationSlotResult> {
    const db = await this.open();
    const tx = db.transaction([CREATION_STORE, STORE], "readwrite");
    const slots = tx.objectStore(CREATION_STORE);
    const slot = this.creationSlot(await request(slots.get(projectId ?? "")));
    const attempt = slot.attempt;
    if (attempt?.attemptId !== attemptId) {
      await complete(tx);
      return { kind: "conflict", slot };
    }
    if (attempt.submission) {
      if (!destination.optimisticUserTurnId) {
        tx.abort();
        throw new Error("Creation admission requires its optimistic turn");
      }
      const admissions = tx.objectStore(STORE);
      const key = {
        projectId: attempt.projectId,
        threadId: attempt.threadId,
        submissionId: attempt.submission.submissionId,
      };
      const existing = await request(admissions.get(id(key)));
      if (
        existing !== undefined &&
        (!valid(existing) ||
          existing.creation?.projectId !== projectId ||
          existing.creation?.attemptId !== attemptId ||
          JSON.stringify(existing.envelope) !== JSON.stringify(attempt.submission))
      ) {
        await complete(tx);
        return { kind: "conflict", slot };
      }
      if (existing === undefined)
        admissions.put(
          {
            ...key,
            envelope: attempt.submission,
            latestDraft: slot.draftRevision === attempt.draftRevision ? null : slot.draft,
            optimisticUserTurnId: destination.optimisticUserTurnId,
            state: "ready",
            creation: { projectId, attemptId, draftRevision: slot.draftRevision },
          } satisfies FirstSendContinuityRecord,
          id(key),
        );
    }
    const next: CreationSlot = {
      ...slot,
      revision: slot.revision + 1,
      attempt: {
        ...attempt,
        phase: "ready",
        projectSlug: destination.projectSlug,
        threadSlug: destination.threadSlug,
      },
    };
    slots.put(next, projectId ?? "");
    await complete(tx);
    this.notifyCreation(projectId, next);
    return { kind: "saved", slot: next };
  }

  /** Never retire a newer snapshot than the destination actually restored. */
  async retire(observed: FirstSendContinuityRecord): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction([CREATION_STORE, STORE], "readwrite");
    const admissions = tx.objectStore(STORE);
    const current = await request(admissions.get(id(observed)));
    if (!valid(current)) {
      await complete(tx);
      return true;
    }
    if (
      JSON.stringify(current.latestDraft) !== JSON.stringify(observed.latestDraft) ||
      current.creation?.draftRevision !== observed.creation?.draftRevision
    ) {
      await complete(tx);
      return false;
    }
    let retiredSlot: CreationSlot | undefined;
    if (current.creation) {
      const slots = tx.objectStore(CREATION_STORE);
      const context = current.creation.projectId;
      const slot = this.creationSlot(await request(slots.get(context ?? "")));
      if (
        slot.attempt?.attemptId === current.creation.attemptId &&
        slot.attempt.projectId === current.projectId &&
        slot.attempt.threadId === current.threadId &&
        slot.attempt.submission?.submissionId === current.submissionId
      ) {
        retiredSlot = {
          ...slot,
          revision: slot.revision + 1,
          attempt: null,
          draft: slot.draftRevision === current.creation.draftRevision ? null : slot.draft,
        };
        slots.put(retiredSlot, context ?? "");
      }
    }
    admissions.delete(id(observed));
    await complete(tx);
    if (retiredSlot && current.creation)
      this.notifyCreation(current.creation.projectId, retiredSlot);
    return true;
  }

  private creationSlot(value: unknown): CreationSlot {
    if (value === undefined) return EMPTY_CREATION;
    const slot = value as CreationSlot;
    if (
      slot?.version !== 1 ||
      !Number.isSafeInteger(slot.revision) ||
      !Number.isSafeInteger(slot.draftRevision) ||
      (slot.draft !== null && !validSnapshot(slot.draft)) ||
      !validCreationAttempt(slot.attempt)
    )
      throw new Error("Creation draft is unreadable");
    return slot;
  }

  private async changeCreation(
    projectId: string | null,
    update: (slot: CreationSlot) => CreationSlot | null,
  ): Promise<CreationSlotResult> {
    const db = await this.open();
    const tx = db.transaction([CREATION_STORE, STORE], "readwrite");
    const store = tx.objectStore(CREATION_STORE);
    const slot = this.creationSlot(await request(store.get(projectId ?? "")));
    const changed = update(slot);
    const next = changed ? { ...changed, revision: slot.revision + 1 } : slot;
    if (changed) {
      store.put(next, projectId ?? "");
      const attempt = next.attempt;
      if (attempt?.submission && next.draftRevision !== slot.draftRevision) {
        const admissions = tx.objectStore(STORE);
        const key = id({
          projectId: attempt.projectId,
          threadId: attempt.threadId,
          submissionId: attempt.submission.submissionId,
        });
        const admission = await request(admissions.get(key));
        if (valid(admission) && admission.creation?.attemptId === attempt.attemptId)
          admissions.put(
            {
              ...admission,
              latestDraft: next.draft,
              creation: { ...admission.creation, draftRevision: next.draftRevision },
            },
            key,
          );
      }
    }
    await complete(tx);
    if (changed) this.notifyCreation(projectId, next);
    return { kind: changed ? "saved" : "conflict", slot: next };
  }

  async peek(key: FirstSendContinuityKey): Promise<FirstSendContinuityRecord | null> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readonly");
    const value = await request(tx.objectStore(STORE).get(id(key)));
    await complete(tx);
    return valid(value) ? value : null;
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
      const open = indexedDB.open(`meridian-first-send-${encodeURIComponent(this.accountId)}`, 2);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
        if (!open.result.objectStoreNames.contains(CREATION_STORE))
          open.result.createObjectStore(CREATION_STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.database;
  }
}
