/** Stateful in-memory Work cascade used by repository conformance and domain tests. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { WorkCascade } from "../ports/work-cascade.js";

export type InMemoryWorkChildKind =
  | "thread"
  | "result"
  | "document"
  | "folder"
  | "context-source"
  | "draft-branch";

export type InMemoryWorkChild = {
  id: string;
  workId: WorkId;
  kind: InMemoryWorkChildKind;
  deletedAt: string | null;
  deletedByWorkId: WorkId | null;
  status?: "active" | "closed";
};

export type InMemoryWorkCascade = WorkCascade & {
  add(child: InMemoryWorkChild): void;
  find(id: string): InMemoryWorkChild | null;
};

export function createInMemoryWorkCascade(): InMemoryWorkCascade {
  const children = new Map<string, InMemoryWorkChild>();
  return {
    async transaction(operation) {
      const snapshot = structuredClone(children);
      try {
        return await operation();
      } catch (cause) {
        children.clear();
        for (const [id, child] of snapshot) children.set(id, child);
        throw cause;
      }
    },
    add(child) {
      children.set(child.id, structuredClone(child));
    },
    find(id) {
      const child = children.get(id);
      return child ? structuredClone(child) : null;
    },
    async hide({ workId, at }) {
      const threadIds: ThreadId[] = [];
      for (const child of children.values()) {
        if (child.workId !== workId || child.deletedByWorkId) continue;
        const isBranch = child.kind === "draft-branch";
        if (isBranch ? child.status !== "active" : child.deletedAt !== null) continue;
        child.deletedByWorkId = workId;
        if (isBranch) child.status = "closed";
        else child.deletedAt = at.toISOString();
        if (child.kind === "thread") threadIds.push(child.id as ThreadId);
      }
      return threadIds.sort();
    },
    async unhide({ workId }) {
      for (const child of children.values()) {
        if (child.deletedByWorkId !== workId) continue;
        child.deletedByWorkId = null;
        if (child.kind === "draft-branch") child.status = "active";
        else child.deletedAt = null;
      }
    },
  };
}
