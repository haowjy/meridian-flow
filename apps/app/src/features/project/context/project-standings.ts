/**
 * Where each document stands in its project's list, shared by everything that asks "is it still
 * there": the removal observer, the notice and the editor's own banner. A project's list is held
 * open while anything watches it; its replay is the session's, computed once per change however
 * many ask.
 */
import { type DocumentStanding, listIsReadable, standingAcross } from "@/core/tree-list/standing";
import type { TreeListHandle, TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import type { TreeListSnapshot } from "@/core/tree-list/tree-list-session";

type Watched = {
  handle: TreeListHandle;
  account: TreeListHandle;
  holds: number;
  listeners: Set<() => void>;
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

  standing(projectId: string, documentId: string): DocumentStanding {
    const watched = this.projects.get(projectId);
    if (!watched) return WAITING;
    let answer = watched.answers.get(documentId);
    if (!answer) {
      const list = ({ session }: TreeListHandle) => ({
        snapshot: session.getSnapshot(),
        projection: session.replay(),
      });
      answer = standingAcross(list(watched.handle), list(watched.account), documentId);
      watched.answers.set(documentId, answer);
    }
    return answer;
  }

  inProjectList(projectId: string, documentId: string): boolean {
    return this.projects.get(projectId)?.handle.session.replay().nodes.has(documentId) ?? false;
  }

  status(projectId: string): TreeListSnapshot["status"] {
    return this.projects.get(projectId)?.handle.session.getSnapshot().status ?? "waiting";
  }
}
