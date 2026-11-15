/**
 * Dev-only `window.__meridianTreeList`: opens a list and reads what the tree it holds replays to,
 * so a browser run can see the list before any screen shows it. Step 6's screens read the same
 * session; its write path replaces `append`.
 */

import {
  LIVE,
  listRecords,
  projectedRows,
  replayView,
  sourceRoot,
  TreeWriter,
} from "@meridian/project-tree";
import { DEBUG_FEATURE_ALLOWED } from "../debug-gate";
import type { TreeListHandle, TreeListRegistry } from "./tree-list-registry";

type Api = {
  open(kind: "project" | "account", id: string): Promise<unknown>;
  read(kind: "project" | "account", id: string): unknown;
  /** Appends a `create` of a document in a source, as the account. */
  append(kind: "project" | "account", id: string, sourceId: string, name: string): string;
  /** Appends a record only the server writes (a `purge`): the guard closes a copy that holds one. */
  appendForged(kind: "project" | "account", id: string): void;
  close(): void;
};

declare global {
  interface Window {
    __meridianTreeList?: Api;
  }
}

export function installTreeListDebugHook(
  accountId: string,
  registry: TreeListRegistry,
): () => void {
  if (!DEBUG_FEATURE_ALLOWED || typeof window === "undefined") return () => undefined;
  const handles = new Map<string, TreeListHandle>();
  const listOf = (kind: "project" | "account", id: string) =>
    kind === "project" ? ({ kind, projectId: id } as const) : ({ kind, userId: id } as const);
  const handleOf = (kind: "project" | "account", id: string) => {
    const key = `${kind}:${id}`;
    let handle = handles.get(key);
    if (!handle) {
      handle = registry.acquire(listOf(kind, id));
      handles.set(key, handle);
    }
    return handle;
  };
  const read = (kind: "project" | "account", id: string) => {
    const { session } = handleOf(kind, id);
    const { doc, status, role } = session.getSnapshot();
    const live = replayView(doc, LIVE);
    const rows = [...projectedRows(live).values()].map((row) => ({
      id: row.id,
      name: row.name,
      parent: row.parentId,
      deleted: row.deleted,
    }));
    return {
      status,
      role,
      clientId: doc.clientID,
      records: listRecords(doc).length,
      /** The creates the server dropped (its Work was closed), with its reason. */
      dropped: live.dropped.map(({ name, reason }) => ({ name, reason })),
      rows,
    };
  };
  const api: Api = {
    async open(kind, id) {
      handleOf(kind, id);
      return read(kind, id);
    },
    read,
    append(kind, id, sourceId, name) {
      const { doc } = handleOf(kind, id).session.getSnapshot();
      return new TreeWriter(doc).create(LIVE, `user:${accountId}`, {
        kind: "document",
        name,
        parent: sourceRoot(sourceId),
        filetype: "markdown",
      }).id;
    },
    appendForged(kind, id) {
      const { doc } = handleOf(kind, id).session.getSnapshot();
      const node = crypto.randomUUID();
      new TreeWriter(doc).purge(`user:${accountId}`, { id: crypto.randomUUID(), node }, [node]);
    },
    close() {
      for (const handle of handles.values()) handle.release();
      handles.clear();
    },
  };
  window.__meridianTreeList = api;
  return () => {
    api.close();
    if (window.__meridianTreeList === api) delete window.__meridianTreeList;
  };
}
