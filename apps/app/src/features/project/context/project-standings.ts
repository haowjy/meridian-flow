/**
 * Where each document stands in its project's list, shared by everything that asks "is it still
 * there": the removal observer, the notice and the editor's own banner. A project's list is held
 * open while anything watches it; its replay is the session's, computed once per change however
 * many ask.
 */
import { type DocumentStanding, listIsReadable, standingIn } from "@/core/tree-list/standing";
import type { TreeListHandle, TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import type { TreeListSnapshot } from "@/core/tree-list/tree-list-session";

type Watched = {
  handle: TreeListHandle;
  /** The account's own list (`user://`): a document moved there is still the writer's. */
  account: TreeListHandle;
  holds: number;
  listeners: Set<() => void>;
  /** Answers handed out since the last change: identical while nothing changed. */
  answers: Map<string, DocumentStanding>;
  stop(): void;
};

const WAITING: DocumentStanding = { kind: "waiting" };

export class ProjectStandings {
  private readonly projects = new Map<string, Watched>();

  constructor(
    private readonly lists: TreeListRegistry,
    private readonly accountId: string,
  ) {}

  /** Holds the project's list and calls `listener` when any standing in it may have changed. */
  watch(projectId: string, listener: () => void): () => void {
    let watched = this.projects.get(projectId);
    if (!watched) {
      const handle = this.lists.acquire({ kind: "project", projectId });
      const account = this.lists.acquire({ kind: "account", userId: this.accountId });
      const changed = () => {
        entry.answers = new Map();
        for (const each of [...entry.listeners]) each();
      };
      const stopProject = handle.session.subscribe(changed);
      const stopAccount = account.session.subscribe(changed);
      const entry: Watched = {
        handle,
        account,
        holds: 0,
        listeners: new Set(),
        answers: new Map(),
        stop: () => {
          stopProject();
          stopAccount();
        },
      };
      this.projects.set(projectId, entry);
      watched = entry;
    }
    const held = watched;
    held.holds += 1;
    held.listeners.add(listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      held.listeners.delete(listener);
      held.holds -= 1;
      if (held.holds === 0) {
        held.stop();
        held.handle.release();
        held.account.release();
        this.projects.delete(projectId);
      }
    };
  }

  /** Resolves once the project's list has been read: from then on an absence is an answer. */
  whenReadable(projectId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let stop = () => {};
      const settle = (ready: boolean) => {
        if (!ready && !signal?.aborted) return;
        stop();
        if (ready) resolve();
        else reject(signal?.reason);
      };
      const check = () => settle(listIsReadable(this.status(projectId)));
      stop = this.watch(projectId, check);
      signal?.addEventListener("abort", () => settle(false), { once: true });
      check();
    });
  }

  /** "waiting" while nothing watches the project or its list has not been read. */
  standing(projectId: string, documentId: string): DocumentStanding {
    const watched = this.projects.get(projectId);
    if (!watched) return WAITING;
    let answer = watched.answers.get(documentId);
    if (!answer) {
      const { session } = watched.handle;
      answer = standingIn(session.getSnapshot(), session.replay(), documentId);
      if (answer.kind === "not-in-list") {
        // Not in the project's list: it may have moved to the account's.
        const mine = watched.account.session;
        const there = standingIn(mine.getSnapshot(), mine.replay(), documentId);
        // An account list not yet read cannot say the document is nowhere.
        if (there.kind === "waiting") answer = WAITING;
        else if (there.kind !== "not-in-list") answer = there;
      }
      watched.answers.set(documentId, answer);
    }
    return answer;
  }

  /** The list's own status: `denied` means the account has no access to the project. */
  status(projectId: string): TreeListSnapshot["status"] {
    return this.projects.get(projectId)?.handle.session.getSnapshot().status ?? "waiting";
  }
}
