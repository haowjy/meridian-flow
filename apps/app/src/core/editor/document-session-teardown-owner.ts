import type { DocumentSession } from "./document-session";

type Entry = {
  key: string;
  session: DocumentSession;
  attempt: Promise<void> | null;
};

export class DocumentSessionTeardownOwner {
  private readonly entries = new Map<DocumentSession, Entry>();
  private readonly byRoom = new Map<string, Set<DocumentSession>>();
  private readonly settled = new WeakSet<DocumentSession>();
  private drainAttempt: Promise<void> | null = null;

  constructor(private readonly unavailable: () => Error) {}

  retire(room: string, session: DocumentSession): Promise<void> {
    if (this.settled.has(session)) return Promise.resolve();
    let entry = this.entries.get(session);
    if (!entry) {
      entry = { key: room, session, attempt: null };
      this.entries.set(session, entry);
      const sessions = this.byRoom.get(room) ?? new Set<DocumentSession>();
      sessions.add(session);
      this.byRoom.set(room, sessions);
    }
    return this.start(entry);
  }

  async retireReplaced(session: DocumentSession) {
    await session.whenUnbound();
    return this.retire(session.persistenceName ?? session.roomKey, session);
  }

  retiring(room: string): boolean {
    return this.byRoom.has(room);
  }

  assertAvailable(room: string): void {
    if (this.retiring(room)) throw this.unavailable();
  }

  drain(room?: string): Promise<void> {
    if (room === undefined && this.drainAttempt) return this.drainAttempt;
    const attempted = new Set<DocumentSession>();
    const unfinished = () =>
      room === undefined
        ? [...this.entries.values()]
        : [...(this.byRoom.get(room) ?? [])]
            .map((session) => this.entries.get(session))
            .filter((entry): entry is Entry => entry !== undefined);
    const run = async () => {
      const failures = new Map<DocumentSession, unknown>();
      for (;;) {
        const pending = unfinished().filter((entry) => !attempted.has(entry.session));
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
      if (errors.length > 1) throw new AggregateError(errors, "Session teardown failed");
    };
    const attempt = run();
    if (room !== undefined) return attempt;
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
