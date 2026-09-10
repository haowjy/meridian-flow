/** Retains retired sessions and quarantines their room keys until destruction succeeds. */
import type { DocumentSession } from "./document-session";

export type DocumentSessionRetirementKey = Readonly<{
  kind: "live" | "branch";
  roomKey: string;
}>;

type Entry = {
  key: string;
  retirement: DocumentSessionRetirementKey;
  session: DocumentSession;
  attempt: Promise<void> | null;
};

function qualifiedKey(key: DocumentSessionRetirementKey): string {
  return `${key.kind}:${key.roomKey}`;
}

export class DocumentSessionTeardownOwner {
  private readonly entries = new Map<DocumentSession, Entry>();
  private readonly byRoom = new Map<string, Set<DocumentSession>>();
  private readonly settled = new WeakSet<DocumentSession>();
  private drainAttempt: Promise<void> | null = null;

  constructor(private readonly unavailable: (key: DocumentSessionRetirementKey) => Error) {}

  retire(key: DocumentSessionRetirementKey, session: DocumentSession): Promise<void> {
    if (this.settled.has(session)) return Promise.resolve();
    let entry = this.entries.get(session);
    if (!entry) {
      const room = qualifiedKey(key);
      entry = { key: room, retirement: key, session, attempt: null };
      this.entries.set(session, entry);
      const sessions = this.byRoom.get(room) ?? new Set<DocumentSession>();
      sessions.add(session);
      this.byRoom.set(room, sessions);
    }
    return this.start(entry);
  }

  assertAvailable(key: DocumentSessionRetirementKey): void {
    if (this.byRoom.has(qualifiedKey(key))) throw this.unavailable(key);
  }

  drainRoom(key: DocumentSessionRetirementKey): Promise<void> {
    const room = qualifiedKey(key);
    const attempted = new Set<DocumentSession>();
    const run = async () => {
      const failures = new Map<DocumentSession, unknown>();
      for (;;) {
        const pending = [...(this.byRoom.get(room) ?? [])]
          .map((session) => this.entries.get(session))
          .filter((entry): entry is Entry => entry !== undefined && !attempted.has(entry.session));
        if (pending.length === 0) break;
        for (const entry of pending) attempted.add(entry.session);
        const results = await Promise.allSettled(pending.map((entry) => this.start(entry)));
        results.forEach((result, index) => {
          const session = pending[index]?.session;
          if (!session) return;
          if (result.status === "rejected") failures.set(session, result.reason);
          else failures.delete(session);
        });
      }
      const errors = [...failures.entries()]
        .filter(([session]) => this.entries.has(session))
        .map(([, error]) => error);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Room teardown failed");
    };
    return run();
  }

  drain(): Promise<void> {
    if (this.drainAttempt) return this.drainAttempt;
    const attempted = new Set<DocumentSession>();
    const run = async () => {
      const failures = new Map<DocumentSession, unknown>();
      for (;;) {
        const pending = [...this.entries.values()].filter((entry) => !attempted.has(entry.session));
        if (pending.length === 0) break;
        for (const entry of pending) attempted.add(entry.session);
        const results = await Promise.allSettled(pending.map((entry) => this.start(entry)));
        results.forEach((result, index) => {
          const session = pending[index]?.session;
          if (!session) return;
          if (result.status === "rejected") failures.set(session, result.reason);
          else failures.delete(session);
        });
      }
      const errors = [...failures.entries()]
        .filter(([session]) => this.entries.has(session))
        .map(([, error]) => error);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Session registry teardown failed");
    };
    const attempt = run();
    this.drainAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.drainAttempt === attempt) this.drainAttempt = null;
      })
      .catch(() => undefined);
    return attempt;
  }

  private start(entry: Entry): Promise<void> {
    if (entry.attempt) return entry.attempt;
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(entry.session.destroy());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    entry.attempt = attempt;
    void attempt
      .then(() => this.finish(entry))
      .finally(() => {
        if (entry.attempt === attempt) entry.attempt = null;
      })
      .catch(() => undefined);
    return attempt;
  }

  private finish(entry: Entry): void {
    if (this.entries.get(entry.session) !== entry) return;
    this.entries.delete(entry.session);
    this.settled.add(entry.session);
    const sessions = this.byRoom.get(entry.key);
    sessions?.delete(entry.session);
    if (sessions?.size === 0) this.byRoom.delete(entry.key);
  }
}
